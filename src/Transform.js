/*************************************************************************
 *  @license
 *
 *  Copyright © 2019, 2024 Glenn Wilton
 *  O2 Creative Limited
 *  www.o2creative.co.nz
 *  support@o2creative.co.nz
 *
 * jsColorEngine is free software: you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with this program.
 * If not, see <https://www.gnu.org/licenses/>.
 *
*/


    'use strict';

    var Profile = require('./Profile');
    var convert = require('./convert');
    var defs = require('./def');

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
     *      unrolled `*_loop` interpolators in this file.
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
     *      Only meaningful on the accuracy path (forward()/transform()).
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
     *  @param {('float'|'int')} [options.lutMode='float']
     *      LUT-based image hot-path kernel selector. Only meaningful when
     *      `dataFormat: 'int8'` AND `buildLut: true`. Non-LUT (accuracy)
     *      paths are unaffected — they always run the float code.
     *
     *      Modes (each one falls through to the previous if its kernel
     *      can't service the LUT shape):
     *
     *        - 'float'  — the original floating-point kernels. Safe
     *                     default, bit-stable across releases.
     *
     *        - 'int'    — integer-math kernels reading a u16 mirror LUT
     *                     with Q0.8 fractional weights and Math.imul.
     *                     Typical 1.10–1.15× speedup vs float on real
     *                     ICC profiles, with accuracy ≤2 LSB vs float
     *                     (well under perceptual threshold for u8 image
     *                     data). Uses 4× less LUT memory (Uint16Array
     *                     instead of Float64Array).
     *
     *      v1.2+ will add 'wasm-scalar' / 'wasm-simd' / 'auto'. The
     *      string-enum API is deliberately forward-compatible — you can
     *      set `lutMode: 'auto'` once available and the engine picks
     *      the best kernel for each transform shape.
     *
     *      The integer kernel is NOT recommended for color-measurement
     *      workflows that compare transformed pixel values to reference
     *      targets — use 'float' for that. See `bench/fastLUT_real_world.js`
     *      for accuracy/speed numbers on real profiles.
     *
     *  @param {boolean}            [options.verbose=false]
     *  @param {boolean}            [options.verboseTiming=false]
     *      Log pipeline construction info / build timings to console.
     *
     *  @constructor
     */
     class Transform{
        constructor(options){

        options = options || {};

        // Accept both spellings: `builtLut` (original) and `buildLut` (the name
        // used throughout the JSDoc and in newer docs). They mean the same thing —
        // "precompute and store a LUT for the fast image path". Internally we
        // normalise to `this.builtLut` to keep all downstream code untouched.
        this.builtLut = (options.builtLut === true) || (options.buildLut === true);
        this.lutGridPoints3D = (isNaN(Number(options.lutGridPoints3D))) ? 33 : Number(options.lutGridPoints3D);
        this.lutGridPoints4D = (isNaN(Number(options.lutGridPoints4D))) ? 17 : Number(options.lutGridPoints4D);

        // LUT image-hot-path kernel selector. See JSDoc above for full
                // semantics. v1.1 ships 'float' (default) and 'int'. Future
        // releases will add 'wasm-scalar', 'wasm-simd', and 'auto'.
        // Unknown values fall back to 'float' so a typo can never crash
        // a production transform — verbose mode warns when this happens.
        var rawLutMode = (options.lutMode === undefined) ? 'float' : ('' + options.lutMode);
        switch(rawLutMode){
            case 'float':
            case 'int':
                this.lutMode = rawLutMode;
                break;
            default:
                if(options.verbose === true){
                    console.warn('Unknown lutMode "' + rawLutMode + '" — falling back to "float". Valid values: float, int.');
                }
                this.lutMode = 'float';
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

        this.inputChannels = 0;
        this.outputChannels = 0;
    };
   

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
     * Set a prebuilt lut - which can be used instead of using profiles
     * @param lut
     */
    setLut(lut){
        this.lut = lut;

        if(lut.chain.length < 3){
            throw 'Invalid LUT - chain is too short';
        }

        if(!lut.chain[0].hasOwnProperty('profile')){
            throw 'Invalid LUT - First link is not a profile';
        }

        if(!lut.chain[lut.chain.length - 2].hasOwnProperty('intent')){
            throw 'Invalid LUT - Intent is missing';
        }

        if(!lut.chain[lut.chain.length - 1].hasOwnProperty('profile')){
            throw 'Invalid LUT - Last link is not a profile';
        }

        var inputProfile = lut.chain[0];

        // Intent is the second to last one used on output profile
        var intent = lut.chain[lut.chain.length - 2].intent;

        var outputProfile = lut.chain[lut.chain.length - 1];

        this.chain = lut.chain;

        // Decode if as b64
        if(this.lut.encoding === 'base64'){
            if(this.lut.precision === 16){
                this.lut.CLUT = base64ToUint16Array(this.lut.CLUT);
            } else {
                this.lut.CLUT = base64ToUint8Array(this.lut.CLUT);
            }
            this.lut.encoding = 'number';
        }


        this.create(inputProfile, outputProfile, intent);
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

        if(this.lut === false){
            // validate input and output profiles
            if(!Array.isArray(profileChain)){
                throw 'Invalid profileChain, must be an array';
            }

            if(profileChain.length < 3){
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
        this.inputChannels = this.getProfileChannels(this.inputProfile);

        this.outputProfile = profileChain[chainEnd];
        this.outputChannels = this.getProfileChannels(this.outputProfile);

        this.customStages = customStages;

        // Built lut or if lut pre-supplied use it
        if(this.builtLut || this.lut !== false){
            //
            // Prebuilt luts are faster as they only need 1-2 stages, but they are less accurate
            // and take time to compute, but for  images they are a much better option
            // where speed is more important than accuracy, especially in 8bit
            //

            if(this.lut === false){
                // create temporary pipeline for building LUT, we do not convert input or output as we
                // want the lut to be device encoding 0.0-1.0 end to end, This makes is easier to
                // use the lut in future with any input or output data
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

                // create the prebuilt Lut
                this.lut = this.createLut();
            }

            // rebuild pipeline to use LUT and the LUTinterpolation method, seriously just stay with tetrahedral
            var defaultInterpolation3D = this.interpolation3D
            var defaultInterpolation4D = this.interpolation4D
            this.interpolation3D = this.LUTinterpolation3D;
            this.interpolation4D = this.LUTinterpolation4D;

            this.createPipeline(profileChain,  this.convertInputOutput, this.convertInputOutput, true);

            // restore interpolation
            this.interpolation3D = defaultInterpolation3D;
            this.interpolation4D = defaultInterpolation4D;

        } else {
            // standard pipeline wihtout a prebuilt lut
            this.createPipeline(profileChain, this.convertInputOutput, this.convertInputOutput, false);
            this.lut = false;
        }

        this.pipelineCreated = true;

        // INTEGER HOT PATH (lutMode === 'int'): build the u16 mirror LUT
        // once, after the optimiser has folded the device->int stage and
        // `lut.outputScale` has been bumped from 1 to 255. Build is silent
        // — if the LUT shape isn't supported (1D, 2D, or non-{3,4} output
        // channels), intLut stays undefined and the dispatcher falls back
        // to the float kernel automatically.
        if(this.lutMode === 'int' && this.lut && this.dataFormat === 'int8'){
            this.buildIntLut(this.lut);
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
     * Creates a prebuilt LUT from the current pipeline. This LUT is compatible with ICCProfile
     * LUT structure, and so can be used in the same trilinear/tetrahedral stages
     *
     */
    createLut(){
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

            // Numeric type of the CLUT cells. See `Transform#buildIntLut`
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
        // Current kernel contract (v1.1). When any of these change, bump
        // intLut.version in buildIntLut() AND update the checks below.
        if(intLut.version !== 1){ return false; }
        if(intLut.dataType !== 'u16'){ return false; }
        if(intLut.scale !== 65280){ return false; }
        if(intLut.gpsPrecisionBits !== 16){ return false; }
        // accWidth varies (16 for 3D, 20 for 4D). Both are fine for v1.
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
     * The CLUT scaling (`* 65280`, i.e. 255*256) assumes 0..1 device-encoded
     * LUT values, which is the contract createLut() establishes. The 65280
     * scale (not 65535) is deliberate: it makes u16/256 = u8 exactly, which
     * eliminates a systematic +0.4 % high bias in the final shift-to-u8.
     * For any future LUT source where the [0,1] contract isn't true
     * (e.g. raw Lab16 from ICC v4 mAB tags), this builder needs a separate
     * rescale path — flagged as TODO.
     *
     * The produced `intLut` carries a format tag (`version`, `encoding`,
     * `scale`, `gpsPrecisionBits`, `accWidth`) — see the comment block at
     * the intLut assembly site, and `isIntLutCompatible()` for the check
     * any future deserialization / sharing path should run before handing
     * a foreign intLut to the integer kernels.
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

        // Build u16 mirror of the float CLUT.
        // Float CLUT is in [0, 1] device encoding (createLut() contract).
        //
        // IMPORTANT — scale factor is 255*256 = 65280, NOT 65535.
        // The kernels get from u16 back to u8 via (u16 + 0x80) >> 8 (or
        // the u20 equivalent (u20 + 0x800) >> 12), which is a divide
        // by 256. If we scaled by 65535 here, the round-trip would be
        // u8_out ≈ float * 65535 / 256 = float * 255.996, i.e. ~0.4 %
        // systematic HIGH bias vs the float kernel (which does
        // float * 255 directly). On profiles whose output lands on
        // fractional u8 boundaries (e.g. CMYK→RGB via GRACoL→sRGB),
        // this produced up to 75 % of channels off-by-1 with 100 %
        // of the errors going int > float.
        //
        // By capping at 65280, u16/256 gives u8 exactly. Intermediate
        // CLUT precision is effectively 15.994 bits instead of 16 —
        // a 0.006-bit loss that is well below any accuracy we care
        // about for u8 output. (When we add u16 *output* in v1.2 we
        // can revisit this and either rebuild with a 65535 scale for
        // that path, or accept the 0.4 % range loss.)
        var src = lut.CLUT;
        var u16 = new Uint16Array(src.length);
        for(var i = 0; i < src.length; i++){
            var v = src[i] * 65280;
            if(v < 0){ v = 0; }
            else if(v > 65280){ v = 65280; }
            u16[i] = (v + 0.5) | 0; // round-to-nearest
        }

        // gridPointsScale_fixed in Q0.16: input * gps gives a Q8.16
        // value whose upper 8 bits are the grid index, bits 8..15 are
        // the Q0.8 fractional weight. Q0.16 is needed (not Q0.8) so
        // the true ratio (g1-1)/255 is represented with enough
        // precision. For g1=33 the true ratio is 32/255 = 0.125490...
        // which rounds to 0.12549 = gps=8224 in Q0.16.
        //
        // Earlier code used Q0.8 (gps=32) which truncates to 0.125
        // exactly — that's ~0.1 % LOW per fractional weight. Because
        // CMYK→RGB LUTs are monotonically DECREASING in CMY, a
        // smaller rx weight means less of the negative (a-c0) delta
        // gets applied, so the int result was systematically HIGHER
        // than float (see diag_cmyk_to_rgb.js — 99.9 % of off-by-1
        // errors went int>float). Q0.16 eliminates that asymmetry.
        //
        // Overflow check: input (u8, 0..255) * gps_Q16 (~8224 for
        // g1=33, ~16448 for g1=65) fits well under 2^21, so plain
        // Math.imul stays in i32 range.
        var gps_fixed = Math.round(((g1 - 1) << 16) / 255);

        // Per-axis maxima for the input===255 boundary patch — see
        // bench/int_vs_float.js FINDING #2 for why this is non-optional.
        // The 4D K-axis (go3) needs the same treatment when present.
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
        //                   currently 65280 = 255*256 so u16/256 = u8
        //                   exactly; could become 65535 for a u16-
        //                   output-optimised build, or 32768 if we
        //                   ever reserve a sign bit)
        //   - `gpsPrecisionBits`  (Q0.N weight precision — currently
        //                          16; was 8 pre-v1.1, caused
        //                          systematic directional bias)
        //   - `accWidth`   (accumulator width for 4D — currently 20,
        //                   raising to 22+ would require wider LUT
        //                   or re-proved overflow bounds)
        //
        // Never reuse a version number for a different encoding.
        lut.intLut = {
            // --- format tag ---
            version: 1,              // v1.1 integer encoding
            dataType: 'u16',         // Uint16Array CLUT (matches outer lut.dataType field)
            scale: 65280,            // u16 value for 1.0 (= 255 * 256)
            gpsPrecisionBits: 16,    // gridPointsScale_fixed is Q0.16
            accWidth: supported4D ? 20 : 16,   // 4D uses u20 Q16.4 intermediate

            // --- CLUT and indexing ---
            CLUT: u16,
            gridPointsScale_fixed: gps_fixed,
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
            go3: supported4D ? lut.go3 : 0
        };

        if(this.verboseTiming){
            var dim = supported4D ? '4D' : '3D';
            var dimMaxes = supported4D
                ? ('maxX/Y/Z/K=' + maxX + '/' + maxY + '/' + maxZ + '/' + maxK)
                : ('maxX/Y/Z=' + maxX + '/' + maxY + '/' + maxZ);
            console.log('  lutMode=int: built u16 mirror (' + dim + ') — ' +
                (u16.byteLength / 1024).toFixed(1) + ' KB (' +
                (src.byteLength / 1024).toFixed(1) + ' KB float source), ' +
                'gps_fixed=' + gps_fixed + ', ' + dimMaxes);
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
        for(a = 0; a < gridPoints; a++){
            var device = this.forward([a * step]);
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
        for(a = 0; a < gridPoints; a++){
            av = a * step;
            for(b = 0; b < gridPoints; b++) {
                // input is already scaled to 0.0 to 1.0 as we are using device encoding
                var device = this.forward([av, b * step]);
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
        for(r = 0; r < gridPoints; r++){
            rv = r * step;
            for(g = 0; g < gridPoints; g++){
                gv = g * step;
                for( b = 0; b < gridPoints; b++){
                    // input is already scaled to 0.0 to 1.0 as we are using device encoding
                    var device = this.forward([rv, gv, b * step]);
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
        var c,m,y,k,o;
        var cv,mv,yv
        var count = 0;
        var i;
        var pipeline = this.pipeline;
        var len = pipeline.length;
        var result = [0,0,0,0];
        for(c = 0; c < gridPoints; c++){
            cv = c * step;
            for(m = 0; m < gridPoints; m++){
                mv = m * step;
                for( y = 0; y < gridPoints; y++){
                    yv = y * step;
                    for( k = 0; k < gridPoints; k++){
                        // input is already scaled to 0.0 to 1.0 as we are using device encoding

                        result = [cv, mv, yv, k * step];
                        for(i = 0; i < len; i++){
                            result = pipeline[i].funct.call(this, result, pipeline[i].stageData, pipeline[i]);
                        }
                        for(o = 0; o < outputChannels; o++){
                            CLUT[position++] = result[o];
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
     * `transform()` is the preferred public alias.
     *
     * @param {object|number[]} cmsColor  A colour in the shape implied by
     *      `dataFormat`: an object (`{type, R, G, B}`, `{type, L, a, b}`, …)
     *      for 'object'/'objectFloat', or a flat array for 'device'.
     * @returns {object|number[]}  Output colour in the destination profile's
     *      space, in the shape implied by `dataFormat`.
     * @throws {string} 'No Pipeline' if create()/createMultiStage() hasn't run.
     */
    forward(cmsColor){

        if(!this.pipelineCreated){
            throw 'No Pipeline';
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
        } else {
            for(i = 0; i < len; i++){
                result = pipeline[i].funct.call(this, result, pipeline[i].stageData, pipeline[i]);
            }
        }
        return result;
    };

    /**
     * Public alias of forward(). Prefer this name in user code.
     *
     * Single-colour, accuracy-first conversion. See {@link Transform#forward}
     * for the full contract and the "DO NOT loop over image data" warning.
     *
     * @param {object|number[]} cmsColor
     * @returns {object|number[]}
     */
    transform(cmsColor){
        return this.forward(cmsColor);
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
    transformArrayViaLUT(inputArray, inputHasAlpha, outputHasAlpha, preserveAlpha, pixelCount){
        var lut = this.lut;
        if(!lut){
            throw 'No LUT loaded';
        }

        if(preserveAlpha === undefined){
            preserveAlpha = outputHasAlpha && inputHasAlpha;
        }
        var inputBytesPerPixel = (inputHasAlpha) ? lut.inputChannels + 1 : lut.inputChannels;
        var outputBytesPerPixel = (outputHasAlpha) ? lut.outputChannels + 1 : lut.outputChannels;
        if(pixelCount === undefined){
            pixelCount = Math.floor(inputArray.length / inputBytesPerPixel);
        }
        var outputArray = new Uint8ClampedArray(pixelCount * outputBytesPerPixel);
        var inputChannels = lut.inputChannels;
        var outputChannels = lut.outputChannels;

        // Integer fast path safety check — runs ONCE per array call, not
        // per pixel, so the cost is amortised to zero against the hot
        // loop. We only check when the caller actually asked for the
        // integer path AND an intLut is present; otherwise there's
        // nothing to validate.
        //
        // Why throw (vs. silent anything):
        //   - In v1.1 `buildIntLut()` is the only producer, so a mismatch
        //     can ONLY arise from someone attaching a foreign intLut
        //     (serialised cache from a different version, test fixture,
        //     hand-built object, etc). That is always a dev bug, not a
        //     data-dependent edge case.
        //   - If we did NOT throw (no check at all, or silent fallback
        //     with no signal), the integer kernel would run against a
        //     CLUT / gps / accumulator that disagree with its hardcoded
        //     shift and rounding biases. The output would still look
        //     plausible — no crash, no obvious corruption — but with
        //     an elevated per-channel LSB error rate that is almost
        //     impossible to spot without a pixel-level diff against
        //     the float kernel. That is the single worst failure mode
        //     in a colour pipeline: wrong numbers that nobody notices
        //     until someone prints a proof and the greys cast.
        //   - Throwing gives a clear, immediate, grep-able error
        //     pointing at the exact fix (rebuild via create() or
        //     switch to lutMode:'float'). Loud failure >> silent drift.
        //
        // If you are calling `transformArrayViaLUT` directly with a
        // pre-built intLut you got from somewhere else, this is the
        // guardrail.
        if(this.lutMode === 'int' && lut.intLut && !this.isIntLutCompatible(lut.intLut)){
            throw new Error(
                'jsColorEngine: intLut format tag incompatible with this version. ' +
                'Got {version:' + lut.intLut.version +
                ', dataType:' + JSON.stringify(lut.intLut.dataType) +
                ', scale:' + lut.intLut.scale +
                ', gpsPrecisionBits:' + lut.intLut.gpsPrecisionBits +
                ', accWidth:' + lut.intLut.accWidth + '}. ' +
                'Rebuild the Transform via create() or set lutMode:"float".'
            );
        }

        switch(inputChannels){
            case 1: // Gray / mono
                this.linearInterp1DArray_NCh_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha)
                break;

            case 2: // Duo tones
                this.bilinearInterp2DArray_NCh_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha)
                break;

            case 3: // RGB or Lab
                // INT FAST PATH: integer kernel using u16 LUT and Q0.8 weights.
                // Eligible when lutMode='int' was selected AND buildIntLut()
                // built the mirror LUT (only for supported shapes — see
                // buildIntLut). Falls through to the float kernel otherwise.
                // See JSDoc on the lutMode constructor option for the
                // speed/accuracy tradeoff and bench/fastLUT_real_world.js
                // for numbers.
                if(this.lutMode === 'int' && lut.intLut){
                    switch (outputChannels) {
                        case 3: // RGB > RGB or RGB > Lab — integer hot path
                            this.tetrahedralInterp3DArray_3Ch_intLut_loop(inputArray, 0, outputArray, 0, pixelCount, lut.intLut, inputHasAlpha, outputHasAlpha, preserveAlpha);
                            break;
                        case 4: // RGB > CMYK — integer hot path
                            this.tetrahedralInterp3DArray_4Ch_intLut_loop(inputArray, 0, outputArray, 0, pixelCount, lut.intLut, inputHasAlpha, outputHasAlpha, preserveAlpha);
                            break;
                        default:
                            // Unsupported output channel count (5+ ch). Fall
                            // back to the generic float NCh kernel — note we
                            // pass the FLOAT lut, not lut.intLut, since the
                            // float kernel needs outputScale etc.
                            this.tetrahedralInterp3DArray_NCh_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha);
                            break;
                    }
                    break;
                }

                switch (outputChannels) {
                    case 3: // RGB > RGB or RGB > Lab
                        //if (lut.precision === 16) {
                        //    this.tetrahedralInterp3DArray_3Ch_loop_16bit(inputArray, 0, outputArray, 0, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha)
                        //} else {
                            this.tetrahedralInterp3DArray_3Ch_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha)
                        //}
                        break;
                    case 4: // RGB > CMYK
                       // if (lut.precision === 16) {
                           // this.tetrahedralInterp3DArray_4Ch_loop_16bit(inputArray, 0, outputArray, 0, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha);
                       // } else {
                            this.tetrahedralInterp3DArray_4Ch_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha);
                       // }
                        break;
                    default:
                        this.tetrahedralInterp3DArray_NCh_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha);
                        break
                }
                break;
            case 4: // CMYK
                // INT FAST PATH for 4D LUTs (CMYK input). Same gating as 3D
                // above: requires lutMode='int' AND buildIntLut() to have
                // built the mirror LUT (skipped for unsupported shapes).
                // Bench reference: bench/int_vs_float_4d.js (1.6× standalone,
                // 1.10–1.20× expected in-engine after class-method effect).
                if(this.lutMode === 'int' && lut.intLut){
                    switch(outputChannels){
                        case 3: // CMYK > RGB or CMYK > Lab — integer hot path
                            this.tetrahedralInterp4DArray_3Ch_intLut_loop(inputArray, 0, outputArray, 0, pixelCount, lut.intLut, inputHasAlpha, outputHasAlpha, preserveAlpha);
                            break;
                        case 4: // CMYK > CMYK — integer hot path
                            this.tetrahedralInterp4DArray_4Ch_intLut_loop(inputArray, 0, outputArray, 0, pixelCount, lut.intLut, inputHasAlpha, outputHasAlpha, preserveAlpha);
                            break;
                        default:
                            this.tetrahedralInterp4DArray_NCh_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha);
                            break;
                    }
                    break;
                }

                switch(outputChannels){
                    case 3: // CMYK > RGB or CMYK > Lab
                        this.tetrahedralInterp4DArray_3Ch_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha)
                        break;
                    case 4: // CMYK > CMYK
                        this.tetrahedralInterp4DArray_4Ch_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha)
                        break;
                    default:
                        this.tetrahedralInterp4DArray_NCh_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha);
                        break
                }
                break
            default:
                throw 'Invalid inputChannels ' + inputChannels;
        }

        return outputArray;
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
     *      → transformArrayViaLUT()  — the IMAGE FAST PATH (~45-70 Mpx/s).
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
     *   - Optional `out` buffer to skip allocation in tight realtime loops.
     *
     * @param {Uint8ClampedArray|Uint8Array|Uint16Array|Float32Array|Float64Array|Array} inputArray
     * @param {boolean} inputHasAlpha
     * @param {boolean} outputHasAlpha
     * @param {boolean} [preserveAlpha]
     * @param {number}  [pixelCount]
     * @param {string}  [outputFormat]  See OUTPUT FORMAT above.
     * @returns {Uint8ClampedArray|Uint16Array|Float32Array|Float64Array|Array}
     * @throws {string} 'No Pipeline' if create()/createMultiStage() hasn't run.
     * @throws {string} 'forwardArray can only be used with int8 or int16
     *                  dataFormat' for invalid combinations.
     */
    transformArray(inputArray, inputHasAlpha, outputHasAlpha, preserveAlpha, pixelCount, outputFormat){

        if(!this.pipelineCreated){
            throw 'No Pipeline';
        }

        if(this.dataFormat === 'int8' && this.lut !== false){
            return this.transformArrayViaLUT(inputArray, inputHasAlpha, outputHasAlpha, preserveAlpha, pixelCount);
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
        outputItemsPerPixel = (preserveAlpha) ? this.outputChannels + 1 :  this.outputChannels;

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
                outputArray = new Array(pixelCount * outputItemsPerPixel);
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

            if(this.lut.chain.length < 2){
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
        if(convertOutput && this.dataFormat !== 'device'){
            // Convert from Output Device to outputFormat i.e cmsRGB / cmsLab
            this.createPipeline_Device_to_Output(pcsInfo, profileChain[chainEnd]);

            if(!useCahcedLut) {
                this.insertCustomStage( 'afterDevice2Output', pcsInfo, false);
            }
        }

        if(this.pipelineDebug){
            this.addStage(false, 'END', this.stage_debug, '[PipeLine Output]| {data}', false);
        }

        if(this.optimise){
            // merge stages that can be merged
            this.optimisePipeline();
        }

        // Ensure pipeline is valid by checing that the output of one stage matches the input of the next
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
        }
    };

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
        }
        throw 'Unknown profile type ' + profile.type + 'in getProfileChannels';
    };

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
                return encoding.device;
        }
        throw 'Unknown profile type ' + profile.type + 'in getInput2DevicePCSInfo';
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
                return encoding.device;
        }
        throw 'Unknown profile type ' + profile.type + 'in getDevice2OutputPCSInfo';
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
            } else {
                // Use Inverse Gamma function to convert RGB to linear
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
                this.addStageLUT(
                    false,
                    encoding.device,
                    lut,
                    pcsInfo.pcsEncoding, // Converted to PCSXYZ, or PCSv2 or PCSv4
                    '  [V2_Device_to_PCSv4 : {name}]|({last}) > ({data})'
                );
                break;
            default:
                throw 'UnSupported number of Input Channels ' + lut.inputChannels;
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
                    this.addStageLUT(
                        false,
                        encoding.device, // Device in
                        lut,
                        pcsInfo.pcsEncoding, // PCSV4 or XYZ out
                        '  [V4_Device_to_PCSv4 : {name}]|({last}) > ({data})'
                    );
                    break;
                default:
                    throw 'Unsupported number of Output Channels'
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
            } else {
                // Use Gamma function to adjust to output
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
        switch (lut.inputChannels){

            case 1:
                this.addStage(inputEncoding, 'linearInterp1D', this.linearInterp1D_NCh, lut, outputEncoding, debugFormat);
                break;

            case 2:
                this.addStage(inputEncoding, 'bilinearInterp2D', this.bilinearInterp2D_NCh, lut, outputEncoding, debugFormat);
                break;

            case 3:

                //https://littlecms2.blogspot.com/2010/
                // So, after investigation, I found the reason of those differences: Tetrahedral
                // interpolation being used in 2.0 and Trilinear interpolation in 1.19.
                // Tetrahedral was patented time ago, but now the patent has expired.
                // In fact, I did see such issue many years ago. On LUT elements being
                // indexed by Lab colorspace, Tetrahedral does not work well. I suspect
                // that's because Luma is uncentered (L is on one axis)
                // First thing to discard was a code bug. So I tried Max Derhak's SampleICC.
                // To my astonishment, SampleICC is also using trilinear by default.
                // Tried to modify Max code to do the interpolation as tetrahedral and...
                // bingo! the same "bad" results as Little CMS. Up to four decimals.
                // So here we go, the "bug" is in the interpolation algorithm
                // . I checked PhotoShop CS4. It seems to be also using trilinear as well.
                //
                // Upshot is that we should use trilinear for PCS LUT input, does not matter for output

                // Check for 3 channel input PCS and switch to trilinear
                var interpolation = (useTrilinearFor3ChInput && (inputEncoding === encoding.PCSv4 || inputEncoding === encoding.PCSv2)) ? 'trilinear' : this.interpolation3D;

                switch (interpolation){
                    case 'tetrahedral':

                        if(this.interpolationFast){
                            switch (lut.outputChannels){
                                case 3:
                                    // optimized 3 channel output version
                                    this.addStage(inputEncoding, 'tetrahedralInterp3D', this.tetrahedralInterp3D_3Ch, lut, outputEncoding, debugFormat);
                                    break;
                                case 4:
                                    // optimized 4 channel output version
                                    this.addStage(inputEncoding, 'tetrahedralInterp3D', this.tetrahedralInterp3D_4Ch, lut, outputEncoding, debugFormat);
                                    break;
                                default:
                                    // Generic N channel output
                                    this.addStage(inputEncoding, 'tetrahedralInterp3D', this.tetrahedralInterp3D_NCh, lut, outputEncoding, debugFormat);
                                    break;
                            }
                            break;
                        } else {
                            // Use this to test the tetrahedralInterp3D function, this is the slowest method but we know its accurate
                            this.addStage(inputEncoding, 'tetrahedralInterp3D', this.tetrahedralInterp3D_3or4Ch, lut, outputEncoding, debugFormat);
                        }
                        break;

                    case 'trilinear':
                        switch (lut.outputChannels){
                            // case 4:
                            //     this.addStage(inputEncoding, 'trilinearInterp3D', this.trilinearInterp3D_3or4Ch, lut, outputEncoding, debugFormat);
                            //     break;
                            default:
                                this.addStage(inputEncoding, 'trilinearInterp3D', this.trilinearInterp3D_NCh, lut, outputEncoding, debugFormat);
                                break;

                        }
                        break;
                    default:
                        throw 'Unknown 3D interpolation method "' + interpolation + '"';
                }
                break
            case 4:
                switch (this.interpolation4D){
                    case 'tetrahedral':

                        if(this.interpolationFast) {
                            switch (lut.outputChannels) {
                                case 3:
                                    // optimized 3 channel output version
                                    this.addStage(inputEncoding, 'tetrahedralInterp4D', this.tetrahedralInterp4D_3Ch, lut, outputEncoding, debugFormat);
                                    break;
                                case 4:
                                    // optimized 4 channel output version
                                    this.addStage(inputEncoding, 'tetrahedralInterp4D', this.tetrahedralInterp4D_4Ch, lut, outputEncoding, debugFormat);
                                    break;
                                default:
                                    this.addStage(inputEncoding, 'tetrahedralInterp4D', this.tetrahedralInterp4D_NCh, lut, outputEncoding, debugFormat);
                            }
                        } else {
                            // Use this to test the tetrahedralInterp4D function, this is the slowest method but we know its accurate
                            this.addStage(inputEncoding, 'tetrahedralInterp4D', this.tetrahedralInterp4D_3or4Ch, lut, outputEncoding, debugFormat);
                        }
                        break;

                    case 'trilinear':
                        this.addStage(inputEncoding, 'trilinearInterp4D', this.trilinearInterp4D_3or4Ch, lut, outputEncoding, debugFormat);
                        break;

                    default:
                        throw 'Unknown 4D interpolation method "' + this.interpolation4D + '"';
                }
                break;
            default:
                throw 'Unsupported number of input channels "' + lut.inputChannels + '"';
        }
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

    stage_debug(data, label){
        var lastData = null;
        this.addDebugHistory(label, 'stage_debug', lastData, data);
        return data;
    };

    addDebugHistory(label, stageName, lastData, data){

        if(label.indexOf('{name}') >= 0 ){
            label = label.replace('{name}', stageName );
        }

        var parts = label.split('{');

        for(var i =1 ; i < parts.length ; i++){
            var temp = parts[i].split('}');
            var format = temp[0].split(':');

            switch(format[0].toLowerCase()){
                case 'last':
                    temp[0] = data2String(lastData, format[1], this.debugHistoryDecimals);
                    break;
                case 'data':
                    temp[0] = data2String(data, format[1], this.debugHistoryDecimals);
                    break;
            }
            parts[i] = temp.join('');
        }
        this.debugHistory.push(parts.join(''));
    };

    stage_null(input){
        return input;
    };

    stage_history(input, info){

        // Add the info to the history
        this.debugHistory.push(info);

        return input;
    };



    ////////////////////////////////////////////////////////////////////////////////
    //
    //  Stages for Gray Data
    //

    stage_device_to_Gray(device){
        return {
            G: (device[0] * 255),
            type: eColourType.Gray
        };
    };

    stage_device_to_Grayf(device){
        return {
            Gf: device[0],
            type: eColourType.Grayf
        };
    };

    stage_device_to_Gray_round(device, precision){
        return {
            G: roundN(device[0] * 255, precision),
            type: eColourType.Gray
        };
    };

    /**
     * @param { _cmsGray } cmsGray
     * @returns {_Device}
     */
    stage_Gray_to_Device(cmsGray){
        if(cmsGray.type === eColourType.Gray) {
            return [cmsGray.G / 255]
        }
        throw 'stage_Gray_to_Device: cmsInput expects _cmsGray';
    };

    ////////////////////////////////////////////////////////////////////////////////
    //
    //  Stages for Duotone (2 colour) Data
    //


    stage_device_to_Duo(device){
        return {
            a: (device[0] * 100),
            b: (device[1] * 100),
            type: eColourType.Duo
        };
    };

    stage_device_to_Duof(device){
        return {
            af: device[0],
            bf: device[1],
            type: eColourType.Duof
        };
    };

    stage_device_to_Duo_round(device, precision){
        return {
            a: roundN(device[0] * 100, precision),
            b: roundN(device[1] * 100, precision),
            type: eColourType.Duo
        };
    };

    /**
     * @param { _cmsDuo  |  _cmsDuof} cmsDuo
     * @returns {_Device}
     */
    stage_Duo_to_Device(cmsDuo){
        if(cmsDuo.type === eColourType.Duo) {
            return [cmsDuo.a / 100, cmsDuo.b / 100]
        } else if(cmsDuo.type === eColourType.Duof) {
            return [cmsDuo.af, cmsDuo.bf]
        }
        throw 'stage_Duo_to_Device: cmsInput expects _cmsDuo';
    };

    ////////////////////////////////////////////////////////////////////////////////
    //
    //  Stages for RGB Data
    //

    stage_device_to_RGB(device){
        return {
            R: (device[0] * 255),
            G: (device[1] * 255),
            B: (device[2] * 255),
            type: eColourType.RGB
        };
    };

    stage_device_to_RGB_round(device, precision){
        return {
            R: roundN(device[0] * 255, precision),
            G: roundN(device[1] * 255, precision),
            B: roundN(device[2] * 255, precision),
            type: eColourType.RGB
        };
    };

    stage_device_to_RGBf(device){
        return {
            Rf: device[0],
            Gf: device[1],
            Bf: device[2],
            type: eColourType.RGBf
        };
    };

    /**
     * @param {_cmsRGB | _cmsRGBf} cmsRGB
     * @returns {_Device}
     */
    stage_RGB_to_Device(cmsRGB){
        if(cmsRGB.type === eColourType.RGB) {
            return [cmsRGB.R / 255, cmsRGB.G / 255, cmsRGB.B / 255]
        }
        if(cmsRGB.type === eColourType.RGBf) {
            return [cmsRGB.Rf, cmsRGB.Gf, cmsRGB.Bf]
        }
        throw 'InputtoPCS: cmsInput is not of type RGB or RGBf';
    };




    ////////////////////////////////////////////////////////////////////////////////
    //
    //   Stages for CMYK Data
    //

    stage_device_to_CMYKf(device){
        return {
            Cf: device[0],
            Mf: device[1],
            Yf: device[2],
            Kf: device[3],
            type: eColourType.CMYKf
        };
    };

    stage_device_to_CMYK(device){
        return {
            C: (device[0] * 100),
            M: (device[1] * 100),
            Y: (device[2] * 100),
            K: (device[3] * 100),
            type: eColourType.CMYK
        };
    };

    stage_device_to_CMYK_round(device, precision){
        return { //  * 0.0015259021896696422
            C: roundN(device[0] * 100, precision),
            M: roundN(device[1] * 100, precision),
            Y: roundN(device[2] * 100, precision),
            K: roundN(device[3] * 100, precision),
            type: eColourType.CMYK
        };
    };

    /**
     * @param {_cmsCMYK |_cmsCMYKf } cmsCMYK
     * @returns {_Device}
     */
    stage_CMYK_to_Device(cmsCMYK){
        if(cmsCMYK.type === eColourType.CMYK) {
            return [cmsCMYK.C / 100, cmsCMYK.M / 100, cmsCMYK.Y / 100, cmsCMYK.K / 100]
        }
        if(cmsCMYK.type === eColourType.CMYKf) {
            return [cmsCMYK.Cf , cmsCMYK.Mf , cmsCMYK.Yf, cmsCMYK.Kf]
        }
        throw 'stage_CMYK_to_Device: cmsInput expects _cmsCMYK or _cmsCMYKf ';
    };

    ////////////////////////////////////////////////////////////////////////////////
    //
    //
    //                     Stages for  Int Data
    //
    //

    stage_device1_to_int(device, intSize){
        return [
            Math.round(device[0] * intSize)
        ];
    };

    stage_device2_to_int(device, intSize){
        return [
            Math.round(device[0] * intSize),
            Math.round(device[1] * intSize),
        ];
    };


    stage_device3_to_int(device, intSize){
        return [
            Math.round(device[0] * intSize),
            Math.round(device[1] * intSize),
            Math.round(device[2] * intSize)
        ];
    };

    stage_device4_to_int(device, intSize){
        return [
            Math.round(device[0] * intSize),
            Math.round(device[1] * intSize),
            Math.round(device[2] * intSize),
            Math.round(device[3] * intSize),
        ];
    };


    /**
     *
     * @param {array} device
     * @param {number} intSize  255 || 65535
     */
    stage_deviceN_to_int(device, intSize){

        //todo - Impliment a dithering method for 8bit output
        var output = new Array(device.length);
        for(var i = 0; i < device.length; i++){
            output[i] = Math.round(device[i] * intSize);
        }
        return output;
    };

    stage_Int_to_Device(data, intScale){
        if(data.length === 3){
            return [
                data[0] / intScale,
                data[1] / intScale,
                data[2] / intScale
            ]
        }
        return [
            data[0] / intScale,
            data[1] / intScale,
            data[2] / intScale,
            data[3] / intScale
        ]
    };

    XYZ(X, Y, Z){
        return {
            type: eColourType.XYZ,
            X:X,
            Y:Y,
            Z:Z,
        };
    };


    Lab(L, a, b, whitePoint){
        return {
            type: eColourType.Lab,
            L: L,
            a: a,
            b: b,
            whitePoint: whitePoint || illuminant.d50
        };
    }

    XYZ2Lab (XYZ, whitePoint){
        var limit = (24.0/116.0) * (24.0/116.0) * (24.0/116.0)
        whitePoint = whitePoint || illuminant.d50;

        var fx = (XYZ.X / whitePoint.X);
        var fy = (XYZ.Y / whitePoint.Y);
        var fz = (XYZ.Z / whitePoint.Z);

        fx = (fx <= limit) ? ((841.0/108.0) * fx) + (16.0/116.0) : Math.pow(fx, 1.0/3.0);
        fy = (fy <= limit) ? ((841.0/108.0) * fy) + (16.0/116.0) : Math.pow(fy, 1.0/3.0);
        fz = (fz <= limit) ? ((841.0/108.0) * fz) + (16.0/116.0) : Math.pow(fz, 1.0/3.0);

        return {
            L: 116.0 * fy - 16.0,
            a: 500.0 * (fx - fy),
            b: 200.0 * (fy - fz),
            whitePoint: whitePoint,
            type: eColourType.Lab
        }

    }

    Lab2XYZ (Lab, whitePoint){
        whitePoint = whitePoint || Lab.whitePoint || illuminant.d50;
        var limit = (24.0/116.0);

        var y = (Lab.L + 16.0) / 116.0;
        var x = y + 0.002 * Lab.a;
        var z = y - 0.005 * Lab.b;

        return {
            X: (x <= limit ? (108.0/841.0) * (x - (16.0/116.0)) : x*x*x) * whitePoint.X,
            Y: (y <= limit ? (108.0/841.0) * (y - (16.0/116.0)) : y*y*y) * whitePoint.Y,
            Z: (z <= limit ? (108.0/841.0) * (z - (16.0/116.0)) : z*z*z) * whitePoint.Z,
            type: eColourType.XYZ
        }
    }

    Lab2PCSv4(labD50){
        return [
            labD50.L / 100,
            (labD50.a + 128)/255,
            (labD50.b + 128)/255
        ];
    };


    Lab2PCSv2(labD50){
        return [
            labD50.L * 652.80 / 65535.0,
            (labD50.a + 128) * 256 / 65535.0,
            (labD50.b + 128) * 256 / 65535.0
        ];
    };

    RGBDevice_to_PCSv4_or_LabD50(device, RGBProfile, asLab, adaptation){
        // Gamma correction
        var R,G,B, matrix, d, d0,d1,d2;

        if(RGBProfile.rgb.rTRC && RGBProfile.rgb.rTRC.use){
            d = this.stage_curves_v4(device, [RGBProfile.rgb.rTRC, RGBProfile.rgb.rTRC, RGBProfile.rgb.rTRC]);
            d0 = d[0];
            d1 = d[1];
            d2 = d[2];
        } else {
            d0 = Math.min(Math.max(device[0], 0.0), 1.0);
            d1 = Math.min(Math.max(device[1], 0.0), 1.0);
            d2 = Math.min(Math.max(device[2], 0.0), 1.0);
        }

        if (RGBProfile.RGBMatrix.issRGB){
            R = convert.sRGBGamma(d0);
            G = convert.sRGBGamma(d1);
            B = convert.sRGBGamma(d2);
        } else {
            var gamma= 1 / RGBProfile.RGBMatrix.gamma;
            R = Math.pow(d0, gamma);
            G = Math.pow(d1, gamma);
            B = Math.pow(d2, gamma);
        }

        if(adaptation){
            // whitespace adaptaton
            matrix = RGBProfile.RGBMatrix.matrixV4;
        } else {
            matrix = RGBProfile.RGBMatrix.XYZMatrix;
        }

        var XYZ = {
            X: R * matrix.m00 + G * matrix.m01 + B * matrix.m02,
            Y: R * matrix.m10 + G * matrix.m11 + B * matrix.m12,
            Z: R * matrix.m20 + G * matrix.m21 + B * matrix.m22
        };

        if(adaptation) {
            // XYZ are now set, but may need chromatic adaptation
            var destWhitePoint = this.d50;
                if (!this.compareWhitePoints(destWhitePoint, RGBProfile.mediaWhitePoint)) {
                XYZ = convert.adaptation(XYZ, RGBProfile.mediaWhitePoint, destWhitePoint);
            }
        }

        if(asLab){
            return this.XYZ2Lab(XYZ, illuminant.d50);
        }

        var lab= this.XYZ2Lab(XYZ, illuminant.d50);

        return [
            lab.L / 100,
            (lab.a + 128)/255,
            (lab.b + 128)/255
        ]
    }

    PCSv4_to_RGBDevice(PCSv4, RGBProfile, adaptation){

        var XYZ = this.Lab2XYZ({
            L:PCSv4[0] * 100,
            a:((PCSv4[1] * 255) - 128.0),
            b: ((PCSv4[2] * 255) - 128.0),
        }, illuminant.d50);
        var R, G, B, matrixInv;

        if(adaptation){
            var whitePoint = illuminant.d50;
            // whitespace adaptaton, Note that there is a tolerance
            if(!convert.compareWhitePoints(whitePoint, RGBProfile.mediaWhitePoint)){
                XYZ = convert.adaptation(XYZ, whitePoint, RGBProfile.mediaWhitePoint);
            }

            // XYZ to RGB
            matrixInv = RGBProfile.RGBMatrix.matrixInv;
        } else {
            matrixInv= RGBProfile.RGBMatrix.XYZMatrixInv;
        }

        R = XYZ.X * matrixInv.m00 + XYZ.Y * matrixInv.m01 + XYZ.Z * matrixInv.m02;
        G = XYZ.X * matrixInv.m10 + XYZ.Y * matrixInv.m11 + XYZ.Z * matrixInv.m12;
        B = XYZ.X * matrixInv.m20 + XYZ.Y * matrixInv.m21 + XYZ.Z * matrixInv.m22;

        if(RGBProfile.rgb.rTRCInv && RGBProfile.rgb.rTRCInv.use){
            return this.stage_curves_v4([R, G, B], [RGBProfile.rgb.rTRCInv, RGBProfile.rgb.rTRCInv, RGBProfile.rgb.rTRCInv]);
        }

        R = Math.min(Math.max(R, 0.0), 1.0);
        G = Math.min(Math.max(G, 0.0), 1.0);
        B = Math.min(Math.max(B, 0.0), 1.0);

        if(RGBProfile.RGBMatrix.issRGB){
            return [
                convert.sRGBGammaInv(R),
                convert.sRGBGammaInv(G),
                convert.sRGBGammaInv(B)
            ];
        } else {
            return [
                Math.pow(R,RGBProfile.RGBMatrix.gamma),
                Math.pow(G,RGBProfile.RGBMatrix.gamma),
                Math.pow(B,RGBProfile.RGBMatrix.gamma)
            ];
        }
    };

    /**
     * Note - That due to the way LitteCMS rounds numbers internally some of the values
     * are not exactly the same as the values output by LittleCMS
     * @param device
     * @param data
     * @returns {number[]}
     * @constructor
     */
    RGBDevice_to_RGBDevice(device, data){

        var Ro,Go,Bo, matrix, igamma;
        var Ri, Gi, Bi;

        if(data.input.curvesInv){
            var d = this.stage_curves_v4(device, data.output.curvesInv);
            Ri = d[0];
            Gi = d[1];
            Bi = d[2];
        } else {
            if (data.input.issRGB){
                Ri = convert.sRGBGammaInv(device[0]);
                Gi = convert.sRGBGammaInv(device[1]);
                Bi = convert.sRGBGammaInv(device[2]);
            } else {
                igamma = data.input.gamma;
                Ri = Math.pow(device[0], igamma);
                Gi = Math.pow(device[1], igamma);
                Bi = Math.pow(device[2], igamma);
            }
        }

        matrix = data.matrix;
        Ro = Ri * matrix.m00 + Gi * matrix.m01 + Bi * matrix.m02;
        Go = Ri * matrix.m10 + Gi * matrix.m11 + Bi * matrix.m12;
        Bo = Ri * matrix.m20 + Gi * matrix.m21 + Bi * matrix.m22;

        // Some clipping
        Ro = Math.min(Math.max(Ro, 0.0), 1.0);
        Go = Math.min(Math.max(Go, 0.0), 1.0);
        Bo = Math.min(Math.max(Bo, 0.0), 1.0);

        // Gamma
        if(data.output.curves){
            return this.stage_curves_v4([Ro, Go, Bo], data.output.curves);
        }

        if(data.output.issRGB){
            return [
                convert.sRGBGamma(Ro),
                convert.sRGBGamma(Go),
                convert.sRGBGamma(Bo)
            ]
        }
        return [
            Math.pow(Ro, 1 / data.output.gamma),
            Math.pow(Go, 1 / data.output.gamma),
            Math.pow(Bo, 1 / data.output.gamma)
        ];
    }

    stage_Gamma(device, data){
        var i0 = Math.min(Math.max(device[0], 0.0), 1.0);
        var i1 = Math.min(Math.max(device[1], 0.0), 1.0);
        var i2 = Math.min(Math.max(device[2], 0.0), 1.0);

        if(data.issRGB){
            return [
                convert.sRGBGamma(i0),
                convert.sRGBGamma(i1),
                convert.sRGBGamma(i2)
            ]
        }
        return [
            Math.pow(i0,1 / data.gamma),
            Math.pow(i1,1 / data.gamma),
            Math.pow(i2,1 / data.gamma)
        ]
    }

    stage_Gamma_Inverse(device, data){
        var i0 = Math.min(Math.max(device[0], 0.0), 1.0);
        var i1 = Math.min(Math.max(device[1], 0.0), 1.0);
        var i2 = Math.min(Math.max(device[2], 0.0), 1.0);

        if(data.issRGB){
            return [
                convert.sRGBGammaInv(i0),
                convert.sRGBGammaInv(i1),
                convert.sRGBGammaInv(i2)
            ]
        }

        return [
            Math.pow(i0, data.gamma),
            Math.pow(i1, data.gamma),
            Math.pow(i2, data.gamma)
        ]
    }
    //m[row][column]
    //  00   01    02
    //  10   11    12
    //  20   21    22
    stage_matrix_rgb(device, matrix){
        var i0, i1, i2;
        var o0, o1, o2
        i0 = device[0]
        i1 = device[1]
        i2 = device[2]

        o0 = i0 * matrix.m00 + i1 * matrix.m01 + i2 * matrix.m02;
        o1 = i0 * matrix.m10 + i1 * matrix.m11 + i2 * matrix.m12;
        o2 = i0 * matrix.m20 + i1 * matrix.m21 + i2 * matrix.m22;

        return [o0, o1, o2];
    }

    stage_chromaticAdaptation(PCSXYZ, data){
        var XYZ = this.XYZ(
            PCSXYZ[0] * 1.999969482421875,
            PCSXYZ[1] * 1.999969482421875,
            PCSXYZ[2] * 1.999969482421875
        );

        XYZ = convert.adaptation(XYZ, data.inWhitePoint, data.outWhitePoint);

        return [
            XYZ.X / 1.999969482421875,
            XYZ.Y / 1.999969482421875,
            XYZ.Z / 1.999969482421875
        ]
    }

    ////////////////////////////////////////////////////////////////////////////////
    //
    //
    //                   Stages for Absolute Adaptation
    //
    //

    stage_absoluteAdaptationIn_PCSXYZ_to_PCSXYZ(pcsXYZ, profile){
        return [
            pcsXYZ[0] *= profile.absoluteAdaptationIn.Xa,
            pcsXYZ[1] *= profile.absoluteAdaptationIn.Ya,
            pcsXYZ[2] *= profile.absoluteAdaptationIn.Za
        ];
    };

    stage_absoluteAdaptationOut_PCSXYZ_to_PCSXYZ (pcsXYZ, profile){
        return [
            pcsXYZ[0] *= profile.absoluteAdaptationOut.Xa,
            pcsXYZ[1] *= profile.absoluteAdaptationOut.Ya,
            pcsXYZ[2] *= profile.absoluteAdaptationOut.Za
        ];
    };

    ////////////////////////////////////////////////////////////////////////////////
    //
    //  Stage for Black Point Compensation
    //

    stage_ApplyBPCScale_PCSXYZ_to_PCSXYZ(PCSXYZ, BPC){
        return [
            ((BPC.scale.X * (PCSXYZ[0] * 1.999969482421875)) + BPC.offset.X) / 1.999969482421875,
            ((BPC.scale.Y * (PCSXYZ[1] * 1.999969482421875)) + BPC.offset.Y) / 1.999969482421875,
            ((BPC.scale.Z * (PCSXYZ[2] * 1.999969482421875)) + BPC.offset.Z) / 1.999969482421875
        ]
    };


    ////////////////////////////////////////////////////////////////////////////////
    //
    //  Stages for converting Mono to PCS without a lut
    //

    stage_grayTRC_to_PCSXYZ_Via_Y(input, curves ){
        var n = this.stage_curves_v4([input[0]], curves)[0];

        return [
            illuminant.d50.X * n / 1.999969482421875,
            illuminant.d50.Y * n / 1.999969482421875,
            illuminant.d50.Z * n / 1.999969482421875,
        ];
    };

    stage_grayTRC_to_PCSV4_Via_L(input, curves ){
        return [
            this.stage_curves_v4([input[0]], curves)[0],
            0.5,
            0.5
        ];
    };

    stage_PCSXYZ_to_grayTRC_via_Y(pcsXYZ, invCurves ){
        var X = pcsXYZ[1] * 1.999969482421875; // grab the XYZ Y value
        return [
            this.stage_curves_v4([X], invCurves)[0],
        ];
    };

    stage_PCSV4_to_grayTRC_via_L(pcslab, invCurves ){
        var L = pcslab[0];
        return [
            this.stage_curves_v4([L], invCurves)[0],
        ];
    };

    ////////////////////////////////////////////////////////////////////////////////
    //
    //  Stage for Convert between PCS
    //

    stage_PCSv4_to_PCSv2(pcsLab){
        // 0x8000 / 0x8080
        // 65280.0/65535
        return [
            pcsLab[0] * 0.9961089494163424,
            pcsLab[1] * 0.9961089494163424,
            pcsLab[2] * 0.9961089494163424
        ]
    };

    /**
     *
     * @param pcsLab
     * @returns {*[]}
     */
    stage_PCSv2_to_PCSv4(pcsLab){
        // 0x8080 / 0x8000
        // 65535.0/65280.0 = 1.00390625
        return [
            pcsLab[0] * 1.00390625,
            pcsLab[1] * 1.00390625,
            pcsLab[2] * 1.00390625
        ]
    };

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // Convert from PCS > X

    // TODO - check optimisation can use this
    stage_LabD50_to_PCSXYZ(labD50){
        var XYZ = this.Lab2XYZ(labD50);

        return [
            XYZ.X / 1.999969482421875,
            XYZ.Y / 1.999969482421875,
            XYZ.Z / 1.999969482421875
        ]
    };

    stage_XYZ_to_PCSXYZ(XYZ){
        return [
            XYZ.X / 1.999969482421875,
            XYZ.Y / 1.999969482421875,
            XYZ.Z / 1.999969482421875
        ]
    };

/**
     *
     * @param {_PCS} PCSv2
     * @returns {_PCS}
     */
    stage_PCSv2_to_PCSXYZ(PCSv2){
        var XYZ = this.Lab2XYZ( this.Lab(
            PCSv2[0] * 100.390625, // L
            ((PCSv2[1] * 255.99609375) - 128.0), // a
            ((PCSv2[2] * 255.99609375) - 128.0),  // b
            illuminant.d50
        ));

        return [
            XYZ.X / 1.999969482421875,
            XYZ.Y / 1.999969482421875,
            XYZ.Z / 1.999969482421875
        ]
    };





    /**
     *
     * @param {_PCS} PCSv4
     * @returns {_PCS}
     */
    stage_PCSv4_to_PCSXYZ(PCSv4){
        var XYZ = this.Lab2XYZ( this.Lab(
            PCSv4[0] * 100, // L
            ((PCSv4[1] * 255) - 128.0), // a
            ((PCSv4[2] * 255) - 128.0), // b
            illuminant.d50
        ));
        return [
            XYZ.X / 1.999969482421875,
            XYZ.Y / 1.999969482421875,
            XYZ.Z / 1.999969482421875
        ]
    };

        /**
     *
     * @param {_cmsXYZ} PCSXYZ
     * @returns {[]}
     */
    stage_PCSXYZ_to_PCSv4(PCSXYZ){
        var XYZ = this.XYZ(
            PCSXYZ[0] * 1.999969482421875,
            PCSXYZ[1] * 1.999969482421875,
            PCSXYZ[2] * 1.999969482421875
        );
        var lab = this.XYZ2Lab(XYZ, illuminant.d50);
        return [
            lab.L / 100,
            (lab.a + 128)/255,
            (lab.b + 128)/255
        ];
    };

    stage_PCSXYZ_to_LabD50(PCSXYZ){
        var XYZ = this.XYZ(
            PCSXYZ[0] * 1.999969482421875,
            PCSXYZ[1] * 1.999969482421875,
            PCSXYZ[2] * 1.999969482421875
        );
        return this.XYZ2Lab(XYZ, illuminant.d50);
    };

    /**
     *
     * @param {_cmsXYZ} PCSXYZ
     * @returns {[]}
     */
    stage_PCSXYZ_to_PCSv2(PCSXYZ){
        var XYZ = this.XYZ(
            PCSXYZ[0] * 1.999969482421875,
            PCSXYZ[1] * 1.999969482421875,
            PCSXYZ[2] * 1.999969482421875,
        );
        var lab = this.XYZ2Lab(XYZ, illuminant.d50);
        return [
            lab.L * 652.80 / 65535.0,
            (lab.a + 128) * 256 / 65535.0,
            (lab.b + 128) * 256 / 65535.0
        ];
    };
    /**
     *
     * @param {_PCS} PCSv2
     * @returns {_cmsLabD50}
     */
    stage_PCSv2_to_LabD50(PCSv2){
        return {
            // L:  PCSv2[0] * 65535 / 652.80,
            // a: ((PCSv2[1] * 65535 / 256.0) - 128.0),
            // b: ((PCSv2[2] * 65535 / 256.0) - 128.0)
            L:  PCSv2[0] * 100.390625,
            a: ((PCSv2[1] * 255.99609375) - 128.0),
            b: ((PCSv2[2] * 255.99609375) - 128.0)
        };
    };

    /**
     * @param {_PCS} PCSv2
     * @returns {_cmsLab}
     */
    stage_PCSv2_to_cmsLab(PCSv2){
        return {
            L:  PCSv2[0] * 100.390625,
            a: ((PCSv2[1] * 255.99609375) - 128.0),
            b: ((PCSv2[2] * 255.99609375) - 128.0),
            type: eColourType.Lab,
            whitePoint: illuminant.d50
        };
    };

    stage_PCSv4_to_LabD50(PCSv4){
        return {
            L:   PCSv4[0] * 100,
            a: ((PCSv4[1] * 255) - 128.0),
            b: ((PCSv4[2] * 255) - 128.0)
        };
    };

    /**
     * @param { _PCS } PCSv4
     * @returns {_cmsLab}
     */
    stage_PCSv4_to_cmsLab(PCSv4){
        return {
            //L:   PCSv4[0] * 65535 / 655.35,
            //a: ((PCSv4[1] * 65535 / 257.0) - 128.0),
            //b: ((PCSv4[2] * 65535 / 257.0) - 128.0),
            L:   PCSv4[0] * 100,
            a: ((PCSv4[1] * 255) - 128.0),
            b: ((PCSv4[2] * 255) - 128.0),
            type: eColourType.Lab,
            whitePoint: illuminant.d50
        };
    };






    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // Convert from cmsLab

    /**
     *
     * @param {_cmsLab} cmsLab
     * @returns {_cmsLabD50}
     */
    stage_cmsLab_to_LabD50(cmsLab){
        if(cmsLab.type === eColourType.Lab){
            return convert.Lab2LabD50(cmsLab);
        }
        throw 'stage_cmsLab_to_LabD50: input is not of type Lab';
    };


    /**
     *
     * @param {Profile} profile
     * @param {_cmsLabD50} LabD50
     * @returns {_Device}
     */
    stage_PCSv4_to_RGBDevice(LabD50, profile ){
        return this.PCSv4_to_RGBDevice(LabD50, profile, this.RGBMatrixWhiteAdadaptation)
    };

    /**
     *
     * @param {Profile} profile
     * @param device
     * @returns {*}
     */
    stage_RGBDevice_to_PCSv4(device, profile){
        return this.RGBDevice_to_PCSv4_or_LabD50(device, profile, false, this.RGBMatrixWhiteAdadaptation);
    };


    /**
     *
     * @param {_cmsLab} labD50
     * @returns {_PCS}
     */
    stage_LabD50_to_PCSv4(labD50){
        return [
            labD50.L / 100,
            (labD50.a + 128)/255,
            (labD50.b + 128)/255
        ];
    };


    stage_LabD50_to_PCSv2(labD50){
        return [
            labD50.L * 652.80 / 65535.0,
            (labD50.a + 128) * 256 / 65535.0,
            (labD50.b + 128) * 256 / 65535.0
        ];
    };

    /**
     * @param {_cmsLabD50} labD50
     * @returns {_cmsLab}
     */
    stage_LabD50_to_cmsLab(labD50){
        return {
            L: labD50.L,
            a: labD50.a,
            b: labD50.b,
            type: eColourType.Lab,
            whitePoint: illuminant.d50
        };
    };


    ////////////////////////////////////////////////////////////////////////////////
    //
    //  Stage for 3 X 3 matrix operations with helper functions
    //

    /**
     *
     * @param matrix
     * @param input
     * @returns {[]}
     *
     *   [ 0 1 2 ] + [ 9  ]
     *   [ 3 4 5 ] + [ 10 ]
     *   [ 6 7 8 ] + [ 11 ]
     */
    stage_matrix_v4(input, matrix){
        //note that the b-curves will clip
        return [
            (matrix[0] * input[0]) + (matrix[1] * input[1]) + (matrix[2] * input[2]) + matrix[9],
            (matrix[3] * input[0]) + (matrix[4] * input[1]) + (matrix[5] * input[2]) + matrix[10],
            (matrix[6] * input[0]) + (matrix[7] * input[1]) + (matrix[8] * input[2]) + matrix[11]
        ]
    };

    stage_matrix_v4_noOffsets(input, matrix){
        //note that the b-curves will clip
        return [
            (matrix[0] * input[0]) + (matrix[1] * input[1]) + (matrix[2] * input[2]) ,
            (matrix[3] * input[0]) + (matrix[4] * input[1]) + (matrix[5] * input[2]) ,
            (matrix[6] * input[0]) + (matrix[7] * input[1]) + (matrix[8] * input[2])
        ]
    };
    /**
     *
     * @param {[]} vector array of 3 points
     * @param {[]} matrix array of 9 points
     *   [ 0 1 2 ]
     *   [ 3 4 5 ]
     *   [ 6 7 8 ]
     */
    evalMatrix( vector, matrix){
        return [
            matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
            matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
            matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2]
        ]
    };

    /**
     *
     * @param {[]} m matrix array of 12 points
     *       0 1 2
     *  0  [ 0 1 2 ]
     *  1  [ 3 4 5 ]
     *  2  [ 6 7 8 ]
     */
    invertMatrix(m){

        var determinant =
            m[0] * (m[8] * m[4] - m[7] * m[5]) -
            m[3] * (m[8] * m[1] - m[7] * m[2]) +
            m[6] * (m[5] * m[1] - m[4] * m[2]);

        var scale = 1.0 / determinant;

        return [
            scale * (m[8] * m[4] - m[7] * m[5]),
            -scale * (m[8] * m[1] - m[7] * m[2]),
            scale * (m[5] * m[1] - m[4] * m[2]),

            -scale * (m[8] * m[3] - m[6] * m[5]),
            scale * (m[8] * m[0] - m[6] * m[2]),
            -scale * (m[5] * m[0] - m[3] * m[2]),

            scale * (m[7] * m[3] - m[6] * m[4]),
            -scale * (m[7] * m[0] - m[6] * m[1]),
            scale * (m[4] * m[0] - m[3] * m[1])
        ]

    };

    invertMatrix3(m){

        var determinant =
            m[0] * (m[9] * m[4] - m[7] * m[4]) -
            m[3] * (m[9] * m[1] - m[7] * m[2]) +
            m[6] * (m[4] * m[1] - m[4] * m[2]);

        var scale = 1.0 / determinant;

        return [
            scale * (m[9] * m[4] - m[7] * m[4]),
            -scale * (m[9] * m[1] - m[7] * m[2]),
            scale * (m[4] * m[1] - m[4] * m[2]),

            -scale * (m[9] * m[3] - m[6] * m[4]),
            scale * (m[9] * m[0] - m[6] * m[2]),
            -scale * (m[4] * m[0] - m[3] * m[2]),

            scale * (m[7] * m[3] - m[6] * m[4]),
            -scale * (m[7] * m[0] - m[6] * m[1]),
            scale * (m[4] * m[0] - m[3] * m[1])
        ]
    };

    ////////////////////////////////////////////////////////////////////////////////
    //
    //  Stage for applying Curves
    //

    stage_curves_parametric(input, curves){
        var channels = input.length;
        var output = new Array(channels);
        for(var i=0; i < channels; i++){
            var c = curves[i];
            output[i] = c.curveFn(c.params, input[i]);
            //output[i] = Math.min(Math.max(y, 0.0), 1.0);
        }
        return output;
    }

    /**
     * array input - Values 0.0 to 1.0
     * curve array of points in ICC V4 format
     *
     * @param {Profile.inputCurve | Profile.outputCurve} input
     * @param {object} curves  = Array of Curves - One for each Channel
     * @returns {number[]}
     */
    stage_curves_v4(input, curves ){
        var output;
        var channels = curves.length;
        if(channels === 3){
            output = [0.0, 0.0, 0.0];
        } else {
            output = [0.0, 0.0, 0.0, 0.0];
        }
        for(var i=0; i < channels; i++){
            var c = curves[i];
            if(c.curveFn){
                //
                // Use Parametric Function,
                // These are automatically inverted at creation in mAB or mAB
                //
                output[i] = c.curveFn(c.params, input[i]);
            } else {
                //
                // Interpolate the curve
                //
                var countMinus1 = c.count -1;
                var p = input[i];
                if(p >= 1.0){
                    output[i] = c.dataf[countMinus1];
                } else if(p <= 0.0){
                    output[i] = c.dataf[0] ;
                } else {
                    var pX = p * (countMinus1);
                    var pX0 = Math.floor(pX);
                    var data0 = curves[i].dataf[pX0];
                    output[i] = (data0 + ( (pX - pX0) * ( curves[i].dataf[pX0 + 1] - data0 ) ));
                }
            }
        }
        return output;
    };

    /**
     * array input - Values 0.0 to 1.0
     * curve array of points in ICC V2 format
     *
     * @param {Profile.inputCurve | Profile.outputCurve} input
     * @param curve
     * @returns {number[]}
     */
    stage_curve_v2(input, curve){
        var offset = 0;

        var channels = curve.channels;
        var tableEntries = curve.entries;
        var tableEntriesMinus1 = tableEntries-1;
        var tablef = curve.tablef;
        var output = new Array(channels)

        for(var i=0; i < channels; i++){
            var p = input[i];
            if(p >= 1.0){
                output[i] = tablef[offset+tableEntriesMinus1];
            } else if(p <= 0.0){
                output[i] = tablef[offset];
            } else {
                var pX = p * (tableEntriesMinus1); // scale to entries
                var pX0 = Math.floor(pX);
                var r = (pX - pX0);

                var y0 = tablef[offset+pX0];
                var y1 = tablef[offset+pX0+1];
                output[i] = y0 + ((y1 - y0) * r);
            }
            offset += tableEntries;
        }

        return output;
    };






/* ========================================================================
 *  ACCURACY PATH — single-colour interpolators
 * ========================================================================
 *
 *  The functions in this section (trilinearInterp3D_*, trilinearInterp4D_*,
 *  tetrahedralInterp3D_*, tetrahedralInterp4D_*, linearInterp1D_NCh,
 *  bilinearInterp2D_NCh) convert ONE colour at a time. They are the stages
 *  that get pushed onto this.pipeline by addStageLUT() and are called by
 *  forward() / transform() / the per-pixel path of transformArray().
 *
 *  Design priorities here are different from the *_loop variants:
 *
 *   - ACCURACY first. Allocations (`new Array(outputChannels)`,
 *     intermediate result objects) are acceptable.
 *   - CORRECTNESS over micro-optimisation. Edge-case clamping, NaN safety,
 *     and clean fallback behaviour matter more than ns-per-call.
 *   - DIAGNOSABILITY. These functions feed pipelineDebug / pipelineHistory
 *     when enabled, so deterministic intermediate values are useful.
 *
 *  When to use which:
 *
 *      INPUT      OUTPUT     FUNCTION                       NOTES
 *      ──────     ──────     ─────────────────────────      ─────────────
 *      1 ch       N ch       linearInterp1D_NCh             Gray
 *      2 ch       N ch       bilinearInterp2D_NCh           Duotone
 *      3 ch       3 ch       tetrahedralInterp3D_3Ch        RGB→RGB / Lab
 *      3 ch       4 ch       tetrahedralInterp3D_4Ch        RGB→CMYK
 *      3 ch       N ch       tetrahedralInterp3D_NCh        RGB→n-color
 *      4 ch       3 ch       tetrahedralInterp4D_3Ch        CMYK→RGB / Lab
 *      4 ch       4 ch       tetrahedralInterp4D_4Ch        CMYK→CMYK
 *      4 ch       N ch       tetrahedralInterp4D_NCh        CMYK→n-color
 *
 *  Trilinear vs tetrahedral
 *  ----------------------------------------------------------------------
 *
 *   For DEVICE LUTs (white at one cube corner, black at the opposite,
 *   colour ramps along the diagonals) tetrahedral is BOTH faster AND more
 *   accurate. Stay on tetrahedral.
 *
 *   For PCS-INPUT LUTs (Lab/XYZ — luma on one axis, a/b on the other two,
 *   data NOT diagonally encoded) tetrahedral subtly mis-samples and
 *   trilinear is more accurate. Matches LittleCMS, SampleICC, Photoshop
 *   behaviour. addStageLUT() switches automatically based on inputEncoding.
 *
 *  Reference vs optimised variants
 *  ----------------------------------------------------------------------
 *
 *   *_3or4Ch / _Master are the easy-to-read "reference" implementations
 *   used when interpolationFast === false (diagnostic / accuracy testing).
 *   The _3Ch / _4Ch / _NCh variants are the fast versions used in
 *   production. They should produce numerically identical results to the
 *   reference variants — the LCMS test suite verifies this.
 *
 *  Channel-dispatched fast variants
 *  ----------------------------------------------------------------------
 *
 *   _3Ch and _4Ch are unrolled per-output-channel. _NCh handles 5+ output
 *   channels with a generic loop. Most real-world workloads hit _3Ch or
 *   _4Ch.
 *
 *  Known issues / TODOs in this section
 *  ----------------------------------------------------------------------
 *
 *   B1.  trilinearInterp3D_3or4Ch upper-edge clamp uses raw input[N] >= 1.0
 *        rather than (X0 === gridPoints-1). Can produce out-of-bounds CLUT
 *        reads when lut.inputScale != 1.0. Other interpolators use the
 *        safer X0-vs-gridEnd test.
 *
 *   B4.  tetrahedralInterp3D_Master and tetrahedralInterp3D_3or4Ch fall
 *        through to `c1 = c2 = c3 = [0,0,0,0]` when none of the 6 octant
 *        comparisons match (only possible with NaN inputs). The single
 *        shared array is aliased to all three slots. The _NCh / _3Ch /
 *        _4Ch variants correctly fall through to a c0-only output.
 *
 *   B5.  Octant predicate ordering varies cosmetically between variants
 *        (e.g. `else if (rx >= ry && rz >= rx)` in _NCh vs
 *        `else if (rz >= rx && rx >= ry)` in _3or4Ch — algebraically
 *        identical, visually distracting on side-by-side review).
 *
 *   P3.  Math.floor(px) vs ~~px is inconsistent across variants.
 *        Standardise when next touching this code; ~~ is faster and
 *        produces an SMI for px in [0, 2^31).
 * ========================================================================
 */

/**
 * 3D trilinear, n-channel output. Accuracy path. See ACCURACY PATH header
 * above for design priorities.
 *
 * Used (in preference to tetrahedral) when the source is a PCS LUT with
 * vertically-encoded luma, where tetrahedral can mis-sample. addStageLUT()
 * routes here automatically for PCSv2 / PCSv4 input.
 *
 * @param {number[]}  input  Device-space input, channels in 0..1.
 * @param {object}    lut    The stage's CLUT object (CLUT, gridPoints,
 *                           inputScale, outputScale, go0..go2, etc.).
 * @returns {number[]}       New array of length lut.outputChannels.
 */
trilinearInterp3D_NCh(input, lut){
    var rx,ry,rz;
    var X0,X1,Y0,Y1,Z0,Z1,px,py,pz, input0, input1, input2;
    var d000, d001, d010, d011, d100, d101, d110, d111;
    var dx00, dx01, dx10, dx11, dxy0, dxy1;

    var outputScale = lut.outputScale;
    var outputChannels = lut.outputChannels;
    var gridEnd = (lut.g1 - 1);
    var gridPointsScale = gridEnd * lut.inputScale;
    var CLUT = lut.CLUT;
    var go0 = lut.go0;
    var go1 = lut.go1;
    var go2 = lut.go2;

    input0 = Math.min(Math.max(input[0], 0), 1);
    input1 = Math.min(Math.max(input[1], 0), 1);
    input2 = Math.min(Math.max(input[2], 0), 1);

    // only px needs to be a float
    px = input0 * gridPointsScale;
    py = input1 * gridPointsScale;
    pz = input2 * gridPointsScale;

    X0 = ~~px; //~~ is the same as Math.floor(px)
    rx = (px - X0); // get the fractional part
    if(X0 === gridEnd){
        X1 = X0 *= go2;// change to index in array
    } else {
        X0 *= go2;
        X1 = X0 + go2;
    }

    Y0 = ~~py;
    ry = (py - Y0);
    if(Y0 === gridEnd){
        Y1 = Y0 *= go1;
    } else {
        Y0 *= go1;
        Y1 = Y0 + go1;
    }

    Z0 = ~~pz;
    rz = (pz - Z0);
    if(Z0 === gridEnd){
        Z1 = Z0 *= go0;
    } else {
        Z0 *= go0;
        Z1 = Z0 + go0;
    }

    var output = new Array(outputChannels);

    for(var c = 0; c < outputChannels; c++){
        d000 = CLUT[X0 + Y0 + Z0];
        d001 = CLUT[X0 + Y0 + Z1];
        d010 = CLUT[X0 + Y1 + Z0];
        d011 = CLUT[X0 + Y1 + Z1];

        d100 = CLUT[X1 + Y0 + Z0];
        d101 = CLUT[X1 + Y0 + Z1];
        d110 = CLUT[X1 + Y1 + Z0];
        d111 = CLUT[X1 + Y1 + Z1];

        dx00 = d000 + ( rx * ( d100 - d000 ));
        dx01 = d001 + ( rx * ( d101 - d001 ));
        dx10 = d010 + ( rx * ( d110 - d010 ));
        dx11 = d011 + ( rx * ( d111 - d011 ));

        dxy0 = dx00 + ( ry * ( dx10 - dx00 ));
        dxy1 = dx01 + ( ry * ( dx11 - dx01 ));
        output[c] = (dxy0 + ( rz * ( dxy1 - dxy0 )))  * outputScale;

        // To go to the next channel we only need to increment the index by 1
        // so rather than go CLUT(X0 + Y0 + Z0 + c) we just increment the X indexes
        X0++;
        X1++;
    }
    return output;
};


    /**
     * 3D trilinear, 3- or 4-channel output. REFERENCE/diagnostic variant —
     * the per-channel-count fast paths are normally used instead. Only
     * reached when interpolationFast === false.
     *
     * Also called internally by trilinearInterp4D_3or4Ch as the inner pass
     * for K-axis interpolation (with K0 as the 4th-axis offset).
     *
     * TODO (B1): Upper-edge clamp at the X1/Y1/Z1 assignment uses the raw
     * input[N] >= 1.0 test instead of (X0 === gridPoints-1). When
     * lut.inputScale != 1.0, an input value below 1.0 can still land X0 on
     * gridPoints-1, after which X1 = X0 + 1 reads past the end of the CLUT.
     * Switch to the X0-vs-gridEnd test used in the other interpolators.
     *
     * @param {number[]} input  3 or 4 channels in 0..1.
     * @param {object}   lut
     * @param {number}  [K0=0] 4D-axis CLUT offset when called from the 4D
     *                         outer wrapper.
     * @returns {number[]}     New array of length 3 or 4.
     */
    trilinearInterp3D_3or4Ch(input, lut, K0){
        K0 = (K0 === undefined) ? 0 : K0;
        var inputChannels = lut.inputChannels;
        var outputChannels = lut.outputChannels;
        var gridPoints = lut.gridPoints[0];
        var CLUT = lut.CLUT;

        var g1 = gridPoints;
        var g2 = gridPoints * g1; // g^2
        var g3 = gridPoints * g2; // g^3

        var X0, Y0, Z0, X1, Y1, Z1;
        var fx, fy, fz,
            d000, d001, d010, d011,
            d100, d101, d110, d111,
            dx00, dx01, dx10, dx11,
            dxy0, dxy1, dxyz;

        var px = input[0] * lut.inputScale;
        var py = input[1] * lut.inputScale;
        var pz = input[2] * lut.inputScale;

        px = Math.min(Math.max(px, 0.0), 1.0);
        py = Math.min(Math.max(py, 0.0), 1.0);
        pz = Math.min(Math.max(pz, 0.0), 1.0);

        px = px * (gridPoints - 1);
        py = py * (gridPoints - 1);
        pz = pz * (gridPoints - 1);

        X0 = Math.floor(px); fx = px - X0;
        Y0 = Math.floor(py); fy = py - Y0;
        Z0 = Math.floor(pz); fz = pz - Z0;

        // TODO (B1): unsafe upper-edge clamp. Tests the raw input ( >= 1.0 )
        // rather than the scaled grid index, so when lut.inputScale != 1.0 it
        // can leave X1/Y1/Z1 at gridPoints, then the lookup() reads past the
        // end of the CLUT (garbage colours, possibly NaN). Other interpolators
        // use the type-independent (X0 === gridPoints - 1) test — switch to
        // that here too. Low impact in practice because most LUTs have
        // inputScale === 1.0, but worth fixing.
        X1 = X0 + ( input[0] >= 1.0 ? 0.0 : 1.0);
        Y1 = Y0 + ( input[1] >= 1.0 ? 0.0 : 1.0);
        Z1 = Z0 + ( input[2] >= 1.0 ? 0.0 : 1.0);

        //lookup
        d000 = lookup(X0, Y0, Z0, K0,  CLUT, inputChannels, outputChannels);
        d001 = lookup(X0, Y0, Z1, K0,  CLUT, inputChannels, outputChannels);
        d010 = lookup(X0, Y1, Z0, K0,  CLUT, inputChannels, outputChannels);
        d011 = lookup(X0, Y1, Z1, K0,  CLUT, inputChannels, outputChannels);

        d100 = lookup(X1, Y0, Z0, K0,  CLUT, inputChannels, outputChannels);
        d101 = lookup(X1, Y0, Z1, K0,  CLUT, inputChannels, outputChannels);
        d110 = lookup(X1, Y1, Z0, K0,  CLUT, inputChannels, outputChannels);
        d111 = lookup(X1, Y1, Z1, K0,  CLUT, inputChannels, outputChannels);


        dx00 = LERP(fx, d000, d100);
        dx01 = LERP(fx, d001, d101);
        dx10 = LERP(fx, d010, d110);
        dx11 = LERP(fx, d011, d111);

        dxy0 = LERP(fy, dx00, dx10);
        dxy1 = LERP(fy, dx01, dx11);

        dxyz = LERP(fz, dxy0, dxy1);

        if(outputChannels === 3){
            return [
                dxyz[0] *= lut.outputScale,
                dxyz[1] *= lut.outputScale,
                dxyz[2] *= lut.outputScale
            ]
        }

        return [
            dxyz[0] *= lut.outputScale,
            dxyz[1] *= lut.outputScale,
            dxyz[2] *= lut.outputScale,
            dxyz[3] *= lut.outputScale
        ];

        function LERP(frac,low,high){
            if(outputChannels === 3){
                return [
                    low[0] + ( frac * ( high[0]-low[0] )),
                    low[1] + ( frac * ( high[1]-low[1] )),
                    low[2] + ( frac * ( high[2]-low[2] ))
                ];
            }

            return [
                low[0] + ( frac * ( high[0]-low[0] )),
                low[1] + ( frac * ( high[1]-low[1] )),
                low[2] + ( frac * ( high[2]-low[2] )),
                low[3] + ( frac * ( high[3]-low[3] ))
            ];
        }

        function lookup(x, y, z, k, CLUT, inputChannels, outputChannels){

            var base;
            if(inputChannels === 3) {
                base = ((x * g2) + (y * g1) + z) * outputChannels;
            } else {
                base = ((k * g3) + (x * g2) + (y * g1) + z) * outputChannels;
            }

            if(outputChannels === 3){
                return [CLUT[base], CLUT[base+1], CLUT[base+2]];
            }
            return [CLUT[base], CLUT[base+1], CLUT[base+2], CLUT[base+3]];
        }
    };

    /**
     * 4D trilinear, 3- or 4-channel output. REFERENCE/diagnostic variant —
     * the per-channel-count fast paths are normally used instead. Only
     * reached when interpolationFast === false.
     *
     * Implemented as two trilinear 3D passes (one at K0, one at K1) followed
     * by a linear interpolation along the K axis between the two results.
     * Includes an early-out when rk === 0 (we landed exactly on a K grid
     * line) to skip the second 3D pass.
     *
     * @param {number[]} input  4 channels in 0..1 (treats input[0] as K).
     * @param {object}   lut
     * @returns {number[]}      New array of length 3 or 4.
     */
    trilinearInterp4D_3or4Ch(input, lut){
        var K0,K1, inputK, pk, rk;
        inputK = pk = Math.max(0.0, Math.min(1.0, input[0] * lut.inputScale));

        pk = pk * (lut.g1 - 1);
        K0 = Math.floor(pk);
        rk = pk - K0;
        K1 = (inputK >= 1.0) ? K0 : K0 + 1;

        var cmyInput = [input[1], input[2], input[3]];

        // Note that K0 and K1 are the offsets into the lut for the 4D case
        var Output1 = this.trilinearInterp3D_3or4Ch(cmyInput, lut, K0 );
        if(rk === 0 ){
            return Output1;
        } // edge case

        var Output2 = this.trilinearInterp3D_3or4Ch(cmyInput, lut, K1);

        // interpolate two results
        // Note that trilinearInterp3D already applies the output scale
        if(lut.outputChannels === 3){
            return [
                Output1[0] + ( Output2[0] - Output1[0] ) * rk,
                Output1[1] + ( Output2[1] - Output1[1] ) * rk,
                Output1[2] + ( Output2[2] - Output1[2] ) * rk,
            ]
        }

        Output1[0] = Output1[0] + ( Output2[0] - Output1[0] ) * rk;
        Output1[1] = Output1[1] + ( Output2[1] - Output1[1] ) * rk;
        Output1[2] = Output1[2] + ( Output2[2] - Output1[2] ) * rk;
        Output1[3] = Output1[3] + ( Output2[3] - Output1[3] ) * rk;
        return Output1;
    };

    /**
     * tetrahedralInterp3D_Master — REFERENCE implementation.
     *
     * The original, easy-to-read version of the 3D tetrahedral interpolator,
     * with the lookup() / sub16() helpers as separate functions. Kept for
     * clarity and as the reference against which the optimised variants are
     * tested. NOT used in production by default — the optimised
     * tetrahedralInterp3D_3or4Ch (~70% faster) is the actual diagnostic
     * fallback when interpolationFast === false.
     *
     * TODO (B4): The final `else { c1 = c2 = c3 = [0,0,0,0]; }` aliases the
     * single literal across all three slots — no callers mutate them, but it
     * is a pre-existing footgun. The optimised _NCh / _3Ch / _4Ch variants
     * correctly fall through to a c0-only output instead.
     *
     * @param {number[]} input
     * @param {object}   lut
     * @param {number}  [K0=0]
     * @returns {number[]}
     */
    tetrahedralInterp3D_Master(input, lut, K0){

        var inputChannels = lut.inputChannels;
        var outputChannels = lut.outputChannels;
        var gridPoints = lut.gridPoints[0];
        var CLUT = lut.CLUT;
        var rx,ry,rz;

        var g1 = gridPoints;
        var g2 = gridPoints*g1; // g^2
        var g3 = gridPoints*g2; // g^3

        var output;
        if(lut.outputChannels === 3){
            output = [0.0,0.0,0.0];
        } else {
            output = [0.0,0.0,0.0,0.0];
        }
        var c0, c1, c2, c3;
        var X0,X1,Y0,Y1,Z0,Z1, px,py,pz, input0, input1, input2
        input0 = px = input[0] * lut.inputScale;
        input1 = py = input[1] * lut.inputScale;
        input2 = pz = input[2] * lut.inputScale;

        px = Math.min(Math.max(px, 0.0), 1.0);
        py = Math.min(Math.max(py, 0.0), 1.0);
        pz = Math.min(Math.max(pz, 0.0), 1.0);

        px = px * (gridPoints-1);
        py = py * (gridPoints-1);
        pz = pz * (gridPoints-1);

        X0 = Math.floor(px);
        rx = (px - X0);
        X1 = X0 + ( input0 >= 1.0 ? 0.0 : 1.0 );

        Y0 = Math.floor(py);
        ry = (py - Y0);
        Y1 = Y0 + ( input1 >= 1.0 ? 0.0 : 1.0 );

        Z0 = Math.floor(pz);
        rz = (pz - Z0);
        Z1 = Z0 + ( input2 >= 1.0 ? 0.0 : 1.0 );

        c0 = lookup(X0, Y0, Z0, K0);

        //console.log('X0='+X0+' Y0='+Y0+' Z0='+Z0+' K0='+K0);
        //console.log(c0);
        if (rx >= ry && ry >= rz) {
            //1
            c1 = sub16( lookup(X1, Y0, Z0, K0) , c0);
            c2 = sub16( lookup(X1, Y1, Z0, K0) , lookup(X1, Y0, Z0, K0));
            c3 = sub16( lookup(X1, Y1, Z1, K0) , lookup(X1, Y1, Z0, K0));
        } else if (rx >= rz && rz >= ry) {
            //2
            c1 = sub16( lookup(X1, Y0, Z0, K0) , c0);
            c2 = sub16( lookup(X1, Y1, Z1, K0) , lookup(X1, Y0, Z1, K0));
            c3 = sub16( lookup(X1, Y0, Z1, K0) , lookup(X1, Y0, Z0, K0));
        } else if (rz >= rx && rx >= ry) {
            //3
            c1 = sub16( lookup(X1, Y0, Z1, K0) , lookup(X0, Y0, Z1, K0));
            c2 = sub16( lookup(X1, Y1, Z1, K0) , lookup(X1, Y0, Z1, K0));
            c3 = sub16( lookup(X0, Y0, Z1, K0) , c0);
        }  else if (ry >= rx && rx >= rz) {
            //4
            c1 = sub16( lookup(X1, Y1, Z0, K0) , lookup(X0, Y1, Z0, K0));
            c2 = sub16( lookup(X0, Y1, Z0, K0) , c0);
            c3 = sub16( lookup(X1, Y1, Z1, K0) , lookup(X1, Y1, Z0, K0));
        } else if (ry >= rz && rz >= rx) {
            //5
            c1 = sub16( lookup(X1, Y1, Z1, K0) , lookup(X0, Y1, Z1, K0));
            c2 = sub16( lookup(X0, Y1, Z0, K0) , c0);
            c3 = sub16( lookup(X0, Y1, Z1, K0) , lookup(X0, Y1, Z0, K0));
        }  else if (rz >= ry && ry >= rx) {
            //6
            c1 = sub16( lookup(X1, Y1, Z1, K0) , lookup(X0, Y1, Z1, K0));
            c2 = sub16( lookup(X0, Y1, Z1, K0) , lookup(X0, Y0, Z1, K0));
            c3 = sub16( lookup(X0, Y0, Z1, K0) , c0);
        } else {
            // TODO (B4): Only reachable with NaN inputs (none of the >= chains
            // hold). Aliasing one literal across c1/c2/c3 is fine because no
            // caller mutates them, but the optimised _NCh / _3Ch / _4Ch
            // variants intentionally fall through to a c0-only output instead
            // of a c0 + (zero * r) sum. Make consistent across all variants.
            c1 = c2 = c3 = [0,0,0,0];
        }

        output[0] = (  c0[0] + (c1[0] * rx) + (c2[0] * ry) + (c3[0] * rz)  ) * lut.outputScale;
        output[1] = (  c0[1] + (c1[1] * rx) + (c2[1] * ry) + (c3[1] * rz)  ) * lut.outputScale;
        output[2] = (  c0[2] + (c1[2] * rx) + (c2[2] * ry) + (c3[2] * rz)  ) * lut.outputScale;
        if(lut.outputChannels === 3){
            return output;
        }
        output[3] = (  c0[3] + (c1[3] * rx) + (c2[3] * ry) + (c3[3] * rz)  ) * lut.outputScale;
        return output;

        function lookup(x, y, z, k){
            var base;
            if(inputChannels === 3){
                base =            ((x * g2) + (y*g1) + z)* outputChannels;
            } else {
                base =((k * g3) + (x * g2) + (y*g1) + z) * outputChannels;
            }

            if(lut.outputChannels === 3){
                return [CLUT[base], CLUT[base+1],CLUT[base+2]];
            }
            return [CLUT[base], CLUT[base+1],CLUT[base+2], CLUT[base+3]];
        }

        function sub16(a,b){
            var r =[];
            r[0] = a[0] - b[0];
            r[1] = a[1] - b[1];
            r[2] = a[2] - b[2];
            if(lut.outputChannels === 3){
                return r;
            }
            r[3] = a[3] - b[3];
            return r;
        }
    };

    /**
     * Optimised reference variant of tetrahedralInterp3D — the lookup() and
     * sub16() helpers are inlined as closures sharing CLUT/g1/g2/g3 with
     * the outer scope, giving ~70% over the _Master form. Used as the
     * fallback when interpolationFast === false (diagnostic path).
     *
     * Production code routes to tetrahedralInterp3D_3Ch / _4Ch / _NCh
     * instead, which avoid the closure helpers entirely.
     *
     * TODO (B4): Same fall-through aliasing as the _Master variant — see
     * its JSDoc.
     *
     * @param {number[]} input
     * @param {object}   lut
     * @param {number}  [K0=0]
     * @returns {number[]}
     */
    tetrahedralInterp3D_3or4Ch(input, lut, K0){
        var rx,ry,rz;
        var inputScale = lut.inputScale;
        var outputScale = lut.outputScale;
        var inputChannels = lut.inputChannels;
        var outputChannels = lut.outputChannels;
        var gridPointsMinus1 = lut.g1 - 1;
        var CLUT = lut.CLUT;
        var g1 = lut.g1;
        var g2 = lut.g2;
        var g3 = lut.g3;

        var c0, c1, c2, c3;
        var X0,X1,Y0,Y1,Z0,Z1,px,py,pz, input0, input1, input2
        input0 = px = input[0] * inputScale;
        input1 = py = input[1] * inputScale;
        input2 = pz = input[2] * inputScale;

        px = Math.min(Math.max(px, 0.0), 1.0);
        py = Math.min(Math.max(py, 0.0), 1.0);
        pz = Math.min(Math.max(pz, 0.0), 1.0);

        px = px * gridPointsMinus1;
        py = py * gridPointsMinus1;
        pz = pz * gridPointsMinus1;

        X0 = Math.floor(px);
        rx = (px - X0);
        X1 = X0 + ( input0 >= 1.0 ? 0.0 : 1.0 );

        Y0 = Math.floor(py);
        ry = (py - Y0);
        Y1 = Y0 + ( input1 >= 1.0 ? 0.0 : 1.0 );

        Z0 = Math.floor(pz);
        rz = (pz - Z0);
        Z1 = Z0 + ( input2 >= 1.0 ? 0.0 : 1.0 );

        c0 = lookup(X0, Y0, Z0, K0);

        if (rx >= ry && ry >= rz) {
            c1 =  sub16lookup(X1, Y0, Z0, K0, c0);
            c2 = sub16Lookup2(X1, Y1, Z0, K0, X1, Y0, Z0, K0);
            c3 = sub16Lookup2(X1, Y1, Z1, K0, X1, Y1, Z0, K0);

        } else if (rx >= rz && rz >= ry) {
            c1 =  sub16lookup(X1, Y0, Z0, K0, c0);
            c2 = sub16Lookup2(X1, Y1, Z1, K0, X1, Y0, Z1, K0);
            c3 = sub16Lookup2(X1, Y0, Z1, K0, X1, Y0, Z0, K0);

        } else if (rz >= rx && rx >= ry) {
            c1 = sub16Lookup2(X1, Y0, Z1, K0, X0, Y0, Z1, K0);
            c2 = sub16Lookup2(X1, Y1, Z1, K0, X1, Y0, Z1, K0);
            c3 =  sub16lookup(X0, Y0, Z1, K0, c0);

        }  else if (ry >= rx && rx >= rz) {
            c1 = sub16Lookup2(X1, Y1, Z0, K0, X0, Y1, Z0, K0);
            c2 =  sub16lookup(X0, Y1, Z0, K0, c0);
            c3 = sub16Lookup2(X1, Y1, Z1, K0, X1, Y1, Z0, K0);

        } else if (ry >= rz && rz >= rx) {
            c1 = sub16Lookup2(X1, Y1, Z1, K0, X0, Y1, Z1, K0);
            c2 =  sub16lookup(X0, Y1, Z0, K0, c0);
            c3 = sub16Lookup2(X0, Y1, Z1, K0, X0, Y1, Z0, K0);

        }  else if (rz >= ry && ry >= rx) {
            c1 = sub16Lookup2(X1, Y1, Z1, K0, X0, Y1, Z1, K0);
            c2 = sub16Lookup2(X0, Y1, Z1, K0, X0, Y0, Z1, K0);
            c3 =  sub16lookup(X0, Y0, Z1, K0, c0);

        } else {
            // TODO (B4): Same fall-through aliasing as tetrahedralInterp3D_Master.
            // Only reachable on NaN input. Harmless today (callers don't mutate)
            // but inconsistent with the optimised variants.
            c1 = c2 = c3 = [0,0,0,0];
        }

        if(outputChannels === 3){
            return [
                (c0[0] + (c1[0] * rx) + (c2[0] * ry) + (c3[0] * rz)) * outputScale,
                (c0[1] + (c1[1] * rx) + (c2[1] * ry) + (c3[1] * rz)) * outputScale,
                (c0[2] + (c1[2] * rx) + (c2[2] * ry) + (c3[2] * rz)) * outputScale,
            ]
        }

        return [
            (c0[0] + (c1[0] * rx) + (c2[0] * ry) + (c3[0] * rz)) * outputScale,
            (c0[1] + (c1[1] * rx) + (c2[1] * ry) + (c3[1] * rz)) * outputScale,
            (c0[2] + (c1[2] * rx) + (c2[2] * ry) + (c3[2] * rz)) * outputScale,
            (c0[3] + (c1[3] * rx) + (c2[3] * ry) + (c3[3] * rz)) * outputScale,
        ]

        function lookup(x, y, z, k){
            var base;
            if(inputChannels === 3){
                base =            ((x * g2) + (y * g1) + z) * outputChannels;
            } else {
                base = ((k * g3) + (x * g2) + (y * g1) + z) * outputChannels;
            }

            if(outputChannels === 3){
                return [CLUT[base++], CLUT[base++],CLUT[base]];
            }
            return [CLUT[base++], CLUT[base++],CLUT[base++], CLUT[base]];
        }

        function sub16lookup(x, y, z, k, b){
            var base, r0, r1, r2, r3;
            if(inputChannels === 3){
                base =             ((x * g2) + (y * g1) + z) * outputChannels;
            } else {
                base = ((k * g3) + (x * g2) + (y * g1) + z) * outputChannels;
            }

            r0 = CLUT[base++] - b[0];
            r1 = CLUT[base++] - b[1];
            r2 = CLUT[base++] - b[2];

            if(outputChannels === 3){
                return [r0, r1, r2];
            }

            r3 = CLUT[base] - b[3];
            return [r0, r1, r2, r3];
        }

        function sub16Lookup2(x1, y1, z1, k1, x2, y2, z2, k2){
            var base1, base2;
            var r0, r1, r2, r3;
            if(inputChannels === 3) {
                base1 =             ((x1 * g2) + (y1 * g1) + z1) * outputChannels;
                base2 =             ((x2 * g2) + (y2 * g1) + z2) * outputChannels;
            } else {
                base1 = ((k1 * g3) + (x1 * g2) + (y1 * g1) + z1) * outputChannels;
                base2 = ((k2 * g3) + (x2 * g2) + (y2 * g1) + z2) * outputChannels;
            }

            r0 = CLUT[base1++] - CLUT[base2++];
            r1 = CLUT[base1++] - CLUT[base2++];
            r2 = CLUT[base1++] - CLUT[base2++];

            if(outputChannels === 3){
                return [r0, r1, r2];
            }
            r3 = CLUT[base1] - CLUT[base2]
            return [r0, r1, r2, r3];
        }
    };

    /**
     * ========================================================================
     *  PERFORMANCE LESSONS — read this before "tidying up" the code below
     * ========================================================================
     *
     *  These rules were established by direct measurement (Chrome V8 +
     *  Firefox SpiderMonkey, see speed_tests/) when building the unrolled
     *  interpolators in this file. They run counter to the usual JS style
     *  guides but they are the difference between 5 Mpx/s and 30 Mpx/s.
     *
     *  1. INLINE FUNCTION CALLS in hot loops.
     *     Even tiny helpers like LERP(a,b,t) or sub16(a,b) cost real time
     *     when invoked millions of times per second. The compiled code
     *     becomes bigger, but the JIT keeps everything in registers and the
     *     net throughput is much higher.
     *
     *  2. DO NOT EXTRACT INTERMEDIATE LOCALS in hot expressions.
     *
     *         FASTER:    a = b * c * d;
     *                    e = b * c * n;
     *
     *         SLOWER:    var t = b * c;
     *                    a = t * d;
     *                    e = t * n;
     *
     *     The "obvious" CSE optimisation actually hurts. Hypothesis: V8's
     *     register allocator spills `t` to memory across the two reads,
     *     whereas the inlined form keeps the partial product in an xmm
     *     register. Verified empirically on these interpolators (~15-25%
     *     regression when intermediate vars were introduced).
     *
     *     EXCEPTION: caching a value that's READ FROM AN ARRAY twice IS
     *     worth it — the array read is the expensive part, not the local
     *     write. Hence the `a = CLUT[base++]; b = CLUT[base++]; ...` pattern
     *     in the unrolled tetra blocks below.
     *
     *  3. AVOID PER-PIXEL ALLOCATIONS.
     *     `new Array(n)`, `[a, b, c]`, `{...}` all trigger GC pressure at
     *     image scale. The single-colour interpolators below DO allocate
     *     (one new Array per call) — that's fine for the accuracy path.
     *     The image-grade `*_loop` functions write directly into a passed
     *     output buffer and allocate nothing per pixel.
     *
     *  4. PREFER `~~x` OVER `Math.floor(x)` for non-negative floats.
     *     Both produce an int32; `~~x` is a couple of ns faster and signals
     *     "I know x is non-negative" to readers. (Currently inconsistent in
     *     this file — TODO P3.)
     *
     *  5. STRUCTURE-OF-ARRAYS for LUTs, not array-of-objects.
     *     The CLUT is one flat Float64Array (or Uint16Array), not an array
     *     of {r,g,b,k} objects. Keeps cache-line utilisation high and lets
     *     the JIT use indexed reads.
     *
     *  6. DON'T CALL BACK INTO `this.foo(...)` from inner loops.
     *     Property lookup + this-binding adds up. The `*_loop` variants
     *     hoist everything they need into local vars at the top.
     *
     *  7. TYPE STABILITY — keep variables monomorphic.
     *     The hot vars below stay int (SMI) or stay double; never mix.
     *     The compiler optimises monomorphic operations heavily.
     *
     *  WHEN IN DOUBT: re-run speed_tests/ before AND after your change. If
     *  you can't measure a difference, prefer the more readable version. If
     *  the existing form looks ugly, it is probably ugly for a reason.
     * ========================================================================
     */

    /**
     * 1D linear interpolation, 1-channel input → N-channel output. Accuracy
     * path single-colour variant. Used for Gray-input profiles.
     *
     * @param {number[]} input  [g] in 0..1.
     * @param {object}   lut
     * @returns {number[]}      New array of length lut.outputChannels.
     */
    linearInterp1D_NCh(input, lut){
        var rx,px,X0,X1,input0,
            c0,c1,o
        var outputScale = lut.outputScale;
        var outputChannels = lut.outputChannels;
        var gridEnd = (lut.g1 - 1);
        var gridPointsScale = gridEnd * lut.inputScale;
        var CLUT = lut.CLUT;
        var go0 = lut.go0;

        input0 = Math.min(Math.max(input[0], 0), 1);

        // only px needs to be a float
        px = input0 * gridPointsScale;

        X0 = ~~px;
        rx = (px - X0);
        if(X0 === gridEnd){
            X1 = X0 *= go0;
        } else {
            X0 *= go0;
            X1 = X0 + go0;
        }

        var output = new Array(outputChannels);
        for(o = 0; o < outputChannels; o++){
            c0 = CLUT[X0++];
            c1 = CLUT[X1++];
            output[o] = (c0 + ((c1 - c0) * rx)) * outputScale;
        }
        return output;
    };

    /**
     * 2D bilinear interpolation, 2-channel input → N-channel output. Accuracy
     * path single-colour variant. Used for Duotone-input profiles.
     *
     * @param {number[]} input  [a, b] in 0..1.
     * @param {object}   lut
     * @returns {number[]}      New array of length lut.outputChannels.
     */
    bilinearInterp2D_NCh(input, lut){
        var rx,ry;
        var X0,X1,Y0,Y1,px,py, input0, input1
        var base0, base1,base2,base3,
            c0,c1,c2,c3,
            c02, o

        var outputScale = lut.outputScale;
        var outputChannels = lut.outputChannels;
        var gridEnd = (lut.g1 - 1);
        var gridPointsScale = gridEnd * lut.inputScale;
        var CLUT = lut.CLUT;
        var go0 = lut.go0;
        var go1 = lut.go1;

        input0 = Math.min(Math.max(input[0], 0), 1);
        input1 = Math.min(Math.max(input[1], 0), 1);

        // only px needs to be a float
        px = input0 * gridPointsScale;
        py = input1 * gridPointsScale;

        X0 = ~~px;
        rx = (px - X0);
        if(X0 === gridEnd){
            X1 = X0 *= go1;
        } else {
            X0 *= go1;
            X1 = X0 + go1;
        }

        Y0 = ~~py;
        ry = (py - Y0);
        if(Y0 === gridEnd){
            Y1 = Y0 *= go0;
        } else {
            Y0 *= go0;
            Y1 = Y0 + go0;
        }

        var output = new Array(outputChannels);

        // block1
        base0 = X0 + Y0;
        base1 = X0 + Y1;
        base2 = X1 + Y0;
        base3 = X1 + Y1;
        for(o = 0; o < outputChannels; o++){
            c0 = CLUT[base0++];
            c1 = CLUT[base1++];
            c2 = CLUT[base2++];
            c3 = CLUT[base3++];
            c02 = (c0 + ((c2 - c0) * rx))
            output[o] = (c02 + ((  (c1 + ((c3 - c1) * rx))  - c02) * ry)) * outputScale;
        }
        return output;
    };

    /**
     * 3D tetrahedral interpolation, 3-channel input → N-channel output
     * (typically N >= 5 — n-color separations and the like). Accuracy path.
     *
     * For the common 3→3 (RGB→RGB, RGB→Lab) and 3→4 (RGB→CMYK) cases the
     * unrolled tetrahedralInterp3D_3Ch / _4Ch variants below are dispatched
     * by addStageLUT() instead.
     *
     * @param {number[]} input  3 channels in 0..1.
     * @param {object}   lut
     * @returns {number[]}      New array of length lut.outputChannels.
     */
    tetrahedralInterp3D_NCh(input, lut){
        var rx,ry,rz;
        var X0,X1,Y0,Y1,Z0,Z1,px,py,pz, input0, input1, input2
        var base0, base1,base2, base3, base4,
            a, b, c, o

        var outputScale = lut.outputScale;
        var outputChannels = lut.outputChannels;
        var gridEnd = (lut.g1 - 1);
        var gridPointsScale = gridEnd * lut.inputScale;
        var CLUT = lut.CLUT;
        var go0 = lut.go0;
        var go1 = lut.go1;
        var go2 = lut.go2;

        input0 = Math.min(Math.max(input[0], 0), 1);
        input1 = Math.min(Math.max(input[1], 0), 1);
        input2 = Math.min(Math.max(input[2], 0), 1);

        // only px needs to be a float
        px = input0 * gridPointsScale;
        py = input1 * gridPointsScale;
        pz = input2 * gridPointsScale;

        X0 = ~~px; //~~ is the same as Math.floor(px)
        rx = (px - X0); // get the fractional part
        if(X0 === gridEnd){
            X1 = X0 *= go2;// change to index in array
        } else {
            X0 *= go2;
            X1 = X0 + go2;
        }

        Y0 = ~~py;
        ry = (py - Y0);
        if(Y0 === gridEnd){
            Y1 = Y0 *= go1;
        } else {
            Y0 *= go1;
            Y1 = Y0 + go1;
        }

        Z0 = ~~pz;
        rz = (pz - Z0);
        if(Z0 === gridEnd){
            Z1 = Z0 *= go0;
        } else {
            Z0 *= go0;
            Z1 = Z0 + go0;
        }

        // Starting point
        base0 = X0 + Y0 + Z0;

        var output = new Array(outputChannels);

        if (rx >= ry && ry >= rz) {
            // block1
            base1 = X1 + Y0 + Z0;
            base2 = X1 + Y1 + Z0;
            base4 = X1 + Y1 + Z1;
            for(o = 0; o < outputChannels; o++){
                a = CLUT[base1++];
                b = CLUT[base2++];
                c = CLUT[base0++];
                output[o] = (c + ((a - c) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;
            }

        } else if (rx >= rz && rz >= ry) {
            // block2

            base1 = X1 + Y0 + Z0;
            base2 = X1 + Y1 + Z1;
            base3 = X1 + Y0 + Z1;
            for(o = 0; o < outputChannels; o++){
                a = CLUT[base3++];
                b = CLUT[base1++];
                c = CLUT[base0++];
                output[o] = (c + ((b - c) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz)) * outputScale;
            }

        } else if (rx >= ry && rz >= rx) {
            // block3

            base1 = X1 + Y0 + Z1;
            base2 = X0 + Y0 + Z1;
            base3 = X1 + Y1 + Z1;
            for(o = 0; o < outputChannels; o++){
                a = CLUT[base1++];
                b = CLUT[base2++];
                c = CLUT[base0++];
                output[o] = (c + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c) * rz)) * outputScale;
            }

        } else if (ry >= rx && rx >= rz) {
            // block4

            base1 = X1 + Y1 + Z0;
            base2 = X0 + Y1 + Z0;
            base4 = X1 + Y1 + Z1;
            for(o = 0; o < outputChannels; o++){
                a = CLUT[base2++];
                b = CLUT[base1++];
                c = CLUT[base0++];
                output[o] = (c + ((b - a) * rx) + ((a - c) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;
            }

        } else if (ry >= rz && rz >= rx) {
            // block5

            base1 = X1 + Y1 + Z1;
            base2 = X0 + Y1 + Z1;
            base3 = X0 + Y1 + Z0;
            for(o = 0; o < outputChannels; o++){
                a = CLUT[base2++];
                b = CLUT[base3++];
                c = CLUT[base0++];
                output[o] = (c + ((CLUT[base1++] - a) * rx) + ((b - c) * ry) + ((a - b) * rz)) * outputScale;
            }

        } else if (rz >= ry && ry >= rx) {
            // block6

            base1 = X1 + Y1 + Z1;
            base2 = X0 + Y1 + Z1;
            base4 = X0 + Y0 + Z1;
            for(o = 0; o < outputChannels; o++){
                a = CLUT[base2++]
                b = CLUT[base4++]
                c = CLUT[base0++];
                output[o] = (c + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c) * rz) ) * outputScale;
            }

        } else {
            for(o = 0; o < outputChannels; o++){
                output[o] = CLUT[base0++] * outputScale;
            }
        }

        return output;
    };

    /**
     * 3D tetrahedral interpolation, 3-channel input → 4-channel output.
     * Accuracy path. Used for RGB → CMYK single-colour conversions
     * (e.g. picking RGB swatches and asking "what CMYK would this be").
     *
     * Output channel writes are unrolled (no inner for-o loop) for speed.
     *
     * @param {number[]} input  [r, g, b] in 0..1.
     * @param {object}   lut
     * @returns {number[]}      [c, m, y, k] scaled to lut.outputScale.
     */
    tetrahedralInterp3D_4Ch(input, lut){
        var rx,ry,rz;
        var X0,X1,Y0,Y1,Z0,Z1,px,py,pz, input0, input1, input2
        var base1,base2, base3, base4,
            c0,c1,c2,c3, a, b

        var outputScale = lut.outputScale;
        var gridEnd = (lut.g1 - 1);
        var gridPointsScale = gridEnd * lut.inputScale;
        var CLUT = lut.CLUT;
        var go0 = lut.go0;
        var go1 = lut.go1;
        var go2 = lut.go2;

        input0 = Math.min(1, Math.max(0, input[0]));
        input1 = Math.min(1, Math.max(0, input[1]));
        input2 = Math.min(1, Math.max(0, input[2]));


        // Rather than divide input by 255 then multiply by (lut.g1 - 1)
        // Just do this once, this means input0 stays an int and
        // only px needs to be a float
        px = input0 * gridPointsScale;
        py = input1 * gridPointsScale;
        pz = input2 * gridPointsScale;

        //
        // A few optimisations here, X0 is multiplied by go2, which is precalculated grid x outputChannels
        // Keeping input0 as int means we can just check input0 === 255 rather than input0 >= 1.0 as a float
        // And rather than X0+1 we can just do X0 + offset to location in lut
        X0 = ~~px; //~~ is the same as Math.floor(px)
        rx = (px - X0); // get the fractional part
        if(X0 === gridEnd){
            X1 = X0 *= go2;// change to index in array
        } else {
            X0 *= go2;
            X1 = X0 + go2;
        }

        Y0 = ~~py;
        ry = (py - Y0);
        if(Y0 === gridEnd){
            Y1 = Y0 *= go1;
        } else {
            Y0 *= go1;
            Y1 = Y0 + go1;
        }

        Z0 = ~~pz;
        rz = (pz - Z0);
        if(Z0 === gridEnd){
            Z1 = Z0 *= go0;
        } else {
            Z0 *= go0;
            Z1 = Z0 + go0;
        }

        // Starting point in CLUT
        // Note that X0, Y0, Z0 are all multiplied by the grid offset and the outputChannels
        // So we only need additions rather than n = ((X0 * go2) + (Y0 * go1) + Z0)) * outputChannels
        base1 = X0 + Y0 + Z0;
        c0 = CLUT[base1++];
        c1 = CLUT[base1++];
        c2 = CLUT[base1++];
        c3 = CLUT[base1];

        var output = new Array(4);

        if (rx >= ry && ry >= rz) {
            // block1
            base1 = X1 + Y0 + Z0;
            base2 = X1 + Y1 + Z0;
            //base3 = base1; SAME AS base1
            base4 = X1 + Y1 + Z1;
            //base5 = base2; SAME as base2

            // Important performance issues noted in Chrome and Firefox, assigning intermediate variables slows things down a lot
            // Just having one long line of code is much faster, I suspect internally all this math is done in registers,
            // as the JIT can see that variables are not used, so it can just do the math and store the result
            // If we were to use intermediate variables forces the compiler to read/write memory and potentially trigger the GC
            // However using a/b below to read only once from the array does appear to be faster, The less memory reads the better
            //
            // Note that baseN is increased after each read from the array to move to the next channel
            a = CLUT[base1++];
            b = CLUT[base2++];
            output[0] = (c0 + ((a - c0) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

            a = CLUT[base1++];
            b = CLUT[base2++];
            output[1] = (c1 + ((a - c1) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

            a = CLUT[base1++];
            b = CLUT[base2++];
            output[2] = (c2 + ((a - c2) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

            // Duno if this helps, but no need to increase base1/2/3/4 again as we are done with them
            a = CLUT[base1  ];
            b = CLUT[base2  ];
            output[3] = (c3 + ((a - c3) * rx) +  ((b - a) * ry) + ((CLUT[base4  ] - b) * rz)) * outputScale;

        } else if (rx >= rz && rz >= ry) {
            // block2

            base1 = X1 + Y0 + Z0;
            base2 = X1 + Y1 + Z1;
            base3 = X1 + Y0 + Z1;
            //base4 = base3;
            //base5 = base1;

            a = CLUT[base3++];
            b = CLUT[base1++];
            output[0] =( c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

            a = CLUT[base3++];
            b = CLUT[base1++];
            output[1] =( c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

            a = CLUT[base3++];
            b = CLUT[base1++];
            output[2] =( c2 + ((b - c2) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

            a = CLUT[base3];
            b = CLUT[base1];
            output[3] =( c3 + ((b - c3) * rx) + ((CLUT[base2  ] - a) * ry) + ((a - b) * rz) ) * outputScale;

        } else if (rx >= ry && rz >= rx) {
            // block3

            base1 = X1 + Y0 + Z1;
            base2 = X0 + Y0 + Z1;
            base3 = X1 + Y1 + Z1;
            //base4 = base1;
            //base5 = base2;

            a = CLUT[base1++];
            b = CLUT[base2++];
            output[0] = (c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz)) * outputScale;

            a = CLUT[base1++];
            b = CLUT[base2++];
            output[1] = (c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz)) * outputScale;

            a = CLUT[base1++];
            b = CLUT[base2++];
            output[2] = (c2 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c2) * rz)) * outputScale;

            a = CLUT[base1++];
            b = CLUT[base2++];
            output[3] = (c3 + ((a - b) * rx) + ((CLUT[base3  ] - a) * ry) + ((b - c3) * rz)) * outputScale;

        } else if (ry >= rx && rx >= rz) {
            // block4

            base1 = X1 + Y1 + Z0;
            base2 = X0 + Y1 + Z0;
            //base3 = base2;
            base4 = X1 + Y1 + Z1;
            //base5 = base1;

            a = CLUT[base2++];
            b = CLUT[base1++];
            output[0] = (c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

            a = CLUT[base2++];
            b = CLUT[base1++];
            output[1] = (c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

            a = CLUT[base2++];
            b = CLUT[base1++];
            output[2] = (c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

            a = CLUT[base2];
            b = CLUT[base1];
            output[3] = (c3 + ((b - a) * rx) + ((a - c3) * ry) + ((CLUT[base4  ] - b) * rz) ) * outputScale;

        } else if (ry >= rz && rz >= rx) {
            // block5

            base1 = X1 + Y1 + Z1;
            base2 = X0 + Y1 + Z1;
            base3 = X0 + Y1 + Z0;
            //base4 = base2;
            //base5 = base3;

            a = CLUT[base2++];
            b = CLUT[base3++];
            output[0] = (c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz) ) * outputScale;

            a = CLUT[base2++];
            b = CLUT[base3++];
            output[1] = (c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz) ) * outputScale;

            a = CLUT[base2++];
            b = CLUT[base3++];
            output[2] = (c2 + ((CLUT[base1++] - a) * rx) + ((b - c2) * ry) + ((a - b) * rz) ) * outputScale;

            a = CLUT[base2++];
            b = CLUT[base3++];
            output[3] = (c3 + ((CLUT[base1++] - a) * rx) + ((b - c3) * ry) + ((a - b) * rz) ) * outputScale;

        } else if (rz >= ry && ry >= rx) {
            // block6

            base1 = X1 + Y1 + Z1;
            base2 = X0 + Y1 + Z1;
            //base3 = base2;
            base4 = X0 + Y0 + Z1;
            //base5 = base4;

            a = CLUT[base2++]
            b = CLUT[base4++]
            output[0] = (c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz) ) * outputScale;

            a = CLUT[base2++]
            b = CLUT[base4++]
            output[1] = (c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz) ) * outputScale;

            a = CLUT[base2++]
            b = CLUT[base4++]
            output[2] = (c2 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c2) * rz) ) * outputScale;

            a = CLUT[base2]
            b = CLUT[base4]
            output[3] = (c3 + ((CLUT[base1  ] - a) * rx) + ((a - b) * ry) + ((b - c3) * rz) ) * outputScale;

        } else {
            output[0] = c0 * outputScale;
            output[1] = c1 * outputScale;
            output[2] = c2 * outputScale;
            output[3] = c3 * outputScale;
        }

        return output;
    };

    /**
     * 3D tetrahedral interpolation, 3-channel input → 3-channel output.
     * Accuracy path. Used for RGB → RGB and RGB → Lab single-colour
     * conversions — by far the most-called accuracy-path interpolator.
     *
     * Output channel writes are unrolled (no inner for-o loop) for speed.
     *
     * @param {number[]} input  [r, g, b] in 0..1.
     * @param {object}   lut
     * @returns {number[]}      [x, y, z] scaled to lut.outputScale.
     */
    tetrahedralInterp3D_3Ch(input, lut){
        var rx,ry,rz,
            X0,X1,Y0,
            Y1,Z0,Z1,
            px,py,pz,
            input0, input1, input2
        var base1,base2,base3,base4,
            c0,c1,c2, a, b

        var outputScale = lut.outputScale;
        var gridEnd = (lut.g1 - 1);
        var gridPointsScale = gridEnd * lut.inputScale;
        var CLUT = lut.CLUT;
        var go0 = lut.go0;
        var go1 = lut.go1;
        var go2 = lut.go2;

        // We need some clipping here
        input0 = Math.min(1, Math.max(0, input[0]));
        input1 = Math.min(1, Math.max(0, input[1]));
        input2 = Math.min(1, Math.max(0, input[2]));

        // No clipping checks for speed needed for clamped arrays

        // Rather than divide input by 255 then multiply by (lut.g1 - 1)
        // Just do this once, this means input0 stays an int and
        // only px needs to be a float
        px = input0 * gridPointsScale;
        py = input1 * gridPointsScale;
        pz = input2 * gridPointsScale;

        //
        // A few optimisations here, X0 is multiplied by go2, which is precalculated grid x outputChannels
        // Keeping input0 as int means we can just check input0 === 255 rather than input0 >= 1.0 as a float
        // And rather than X0+1 we can just do X0 + offset to location in lut
        X0 = ~~px; //~~ is the same as Math.floor(px)
        rx = (px - X0); // get the fractional part
        if(X0 === gridEnd){
            X1 = X0 *= go2;
        } else {
            X0 *= go2;
            X1 = X0 + go2;
        }

        Y0 = ~~py;
        ry = (py - Y0);
        if(Y0 === gridEnd){
            Y1 = Y0 *= go1;
        } else {
            Y0 *= go1;
            Y1 = Y0 + go1;
        }

        Z0 = ~~pz;
        rz = (pz - Z0);
        if(Z0 === gridEnd){
            Z1 = Z0 *= go0;
        } else {
            Z0 *= go0;
            Z1 = Z0 + go0;
        }

        // Starting point in CLUT
        // Note that X0, Y0, Z0 are all multiplied by the grid offset and the outputChannels
        // So we only need additions rather than n = ((X0 * go2) + (Y0 * go1) + Z0)) * outputChannels
        base1 = X0 + Y0 + Z0;
        c0 = CLUT[base1++];
        c1 = CLUT[base1++];
        c2 = CLUT[base1];

        var output = new Array(3);

        if (rx >= ry && ry >= rz) {
            // block1
            base1 = X1 + Y0 + Z0;
            base2 = X1 + Y1 + Z0;
            //base3 = base1; SAME AS base1
            base4 = X1 + Y1 + Z1;
            //base5 = base2; SAME as base2

            // Important performance issues noted in Chrome and Firefox, assigning intermediate variables slows things down a lot
            // Just having one long line of code is much faster, I suspect internally all this math is done in registers,
            // as the JIT can see that variables are not used, so it can just do the math and store the result
            // If we were to use intermediate variables forces the compiler to read/write memory and potentially trigger the GC
            // However using a/b below to read only once from the array does appear to be faster, The less memory reads the better
            //
            // Note that baseN is increased after each read from the array to move to the next channel
            a = CLUT[base1++];
            b = CLUT[base2++];
            output[0] = (c0 + ((a - c0) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

            a = CLUT[base1++];
            b = CLUT[base2++];
            output[1] = (c1 + ((a - c1) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

            a = CLUT[base1];
            b = CLUT[base2];
            output[2] = (c2 + ((a - c2) * rx) +  ((b - a) * ry) + ((CLUT[base4] - b) * rz)) * outputScale;


        } else if (rx >= rz && rz >= ry) {
            // block2

            base1 = X1 + Y0 + Z0;
            base2 = X1 + Y1 + Z1;
            base3 = X1 + Y0 + Z1;
            //base4 = base3;
            //base5 = base1;

            a = CLUT[base3++];
            b = CLUT[base1++];
            output[0] =( c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

            a = CLUT[base3++];
            b = CLUT[base1++];
            output[1] =( c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

            a = CLUT[base3];
            b = CLUT[base1];
            output[2] =( c2 + ((b - c2) * rx) + ((CLUT[base2] - a) * ry) + ((a - b) * rz) ) * outputScale;



        } else if (rx >= ry && rz >= rx) {
            // block3

            base1 = X1 + Y0 + Z1;
            base2 = X0 + Y0 + Z1;
            base3 = X1 + Y1 + Z1;
            //base4 = base1;
            //base5 = base2;

            a = CLUT[base1++];
            b = CLUT[base2++];
            output[0] = (c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz)) * outputScale;

            a = CLUT[base1++];
            b = CLUT[base2++];
            output[1] = (c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz)) * outputScale;

            a = CLUT[base1];
            b = CLUT[base2];
            output[2] = (c2 + ((a - b) * rx) + ((CLUT[base3] - a) * ry) + ((b - c2) * rz)) * outputScale;



        } else if (ry >= rx && rx >= rz) {
            // block4

            base1 = X1 + Y1 + Z0;
            base2 = X0 + Y1 + Z0;
            //base3 = base2;
            base4 = X1 + Y1 + Z1;
            //base5 = base1;

            a = CLUT[base2++];
            b = CLUT[base1++];
            output[0] = (c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

            a = CLUT[base2++];
            b = CLUT[base1++];
            output[1] = (c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

            a = CLUT[base2];
            b = CLUT[base1];
            output[2] = (c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4] - b) * rz) ) * outputScale;


        } else if (ry >= rz && rz >= rx) {
            // block5

            base1 = X1 + Y1 + Z1;
            base2 = X0 + Y1 + Z1;
            base3 = X0 + Y1 + Z0;
            //base4 = base2;
            //base5 = base3;

            a = CLUT[base2++];
            b = CLUT[base3++];
            output[0] = (c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz) ) * outputScale;

            a = CLUT[base2++];
            b = CLUT[base3++];
            output[1] = (c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz) ) * outputScale;

            a = CLUT[base2];
            b = CLUT[base3];
            output[2] = (c2 + ((CLUT[base1] - a) * rx) + ((b - c2) * ry) + ((a - b) * rz) ) * outputScale;


        } else if (rz >= ry && ry >= rx) {
            // block6

            base1 = X1 + Y1 + Z1;
            base2 = X0 + Y1 + Z1;
            //base3 = base2;
            base4 = X0 + Y0 + Z1;
            //base5 = base4;

            a = CLUT[base2++]
            b = CLUT[base4++]
            output[0] = (c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz) ) * outputScale;

            a = CLUT[base2++]
            b = CLUT[base4++]
            output[1] = (c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz) ) * outputScale;

            a = CLUT[base2]
            b = CLUT[base4]
            output[2] = (c2 + ((CLUT[base1] - a) * rx) + ((a - b) * ry) + ((b - c2) * rz) ) * outputScale;

        } else {
            output[0] = c0 * outputScale;
            output[1] = c1 * outputScale;
            output[2] = c2 * outputScale;
        }

        return output;
    };

    /**
     * 4D tetrahedral interpolation, 4-channel input → 3-channel output.
     * Accuracy path. Used for CMYK → RGB and CMYK → Lab single-colour
     * conversions (soft-proof picker, ΔE round-trips through CMYK).
     *
     * Implemented as two 3D tetrahedral passes (one at K0, one at K1) and a
     * linear blend across the K axis. Includes an interpK early-out — when
     * rk === 0 the second pass is skipped.
     *
     * @param {number[]} input  [k, c, m, y] in 0..1 (input[0] is the K axis).
     * @param {object}   lut
     * @returns {number[]}      [x, y, z] scaled to lut.outputScale.
     */
    tetrahedralInterp4D_3Ch(input, lut){
        var X0, X1, Y0, K0,
            Y1, Z0, Z1,
            rx, ry, rz, rk,
            px, py, pz, pk,
            input0, input1, input2, inputK,
            base1, base2, base3, base4,
            c0, c1, c2,
            o0, o1, o2,
            d0, d1, d2,
            a, b,
            interpK;

        var outputScale = lut.outputScale;
        var gridEnd = (lut.g1 - 1);
        var gridPointsScale = gridEnd * lut.inputScale;
        var CLUT = lut.CLUT;
        var go0 = lut.go0;
        var go1 = lut.go1;
        var go2 = lut.go2;
        var go3 = lut.go3;
        var kOffset = go3 - lut.outputChannels + 1; // +1 since we don't do a [base++] for the last CLUT lookup

        inputK = Math.min(1,Math.max(0 , input[0])); // K
        input0 = Math.min(1,Math.max(0 , input[1])); // C
        input1 = Math.min(1,Math.max(0 , input[2])); // M
        input2 = Math.min(1,Math.max(0 , input[3])); // Y

        px = input0 * gridPointsScale;
        py = input1 * gridPointsScale;
        pz = input2 * gridPointsScale;
        pk = inputK * gridPointsScale;

        K0 = ~~pk;
        rk = (pk - K0);
        interpK = !(K0 === gridEnd)// K0 and K1 are identical if K0 is the last grid point
        K0 *= go3;
        // No need to calc K1 as we will add kOffset to the base location to get the K1 location

        X0 = ~~px; //~~ is the same as Math.floor(px)
        rx = (px - X0); // get the fractional part
        if(X0 === gridEnd){
            X1 = X0 *= go2;// change to index in array
        } else {
            X0 *= go2;
            X1 = X0 + go2;
        }

        Y0 = ~~py;
        ry = (py - Y0);
        if(Y0 === gridEnd){
            Y1 = Y0 *= go1;
        } else {
            Y0 *= go1;
            Y1 = Y0 + go1;
        }

        Z0 = ~~pz;
        rz = (pz - Z0);
        if(Z0 === gridEnd){
            Z1 = Z0 *= go0;
        } else {
            Z0 *= go0;
            Z1 = Z0 + go0;
        }

        base1 = X0 + Y0 + Z0 + K0;
        c0 = CLUT[base1++];
        c1 = CLUT[base1++];
        c2 = CLUT[base1];

        if(interpK) {
            base1 +=kOffset;
            d0 = CLUT[base1++];
            d1 = CLUT[base1++];
            d2 = CLUT[base1];
        }

        var output = new Array(3);

        if (rx >= ry && ry >= rz) {
            // block1
            base1 = X1 + Y0 + Z0 + K0;
            base2 = X1 + Y1 + Z0 + K0;
            //base3 = base1; SAME AS base1
            base4 = X1 + Y1 + Z1 + K0;
            //base5 = base2; SAME as base2

            // Note that baseN is increased after each read from the array to move to the next channel
            a = CLUT[base1++];
            b = CLUT[base2++];
            o0 = (c0 + ((a - c0) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz));

            a = CLUT[base1++];
            b = CLUT[base2++];
            o1 = (c1 + ((a - c1) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz));

            a = CLUT[base1];
            b = CLUT[base2];
            o2 = (c2 + ((a - c2) * rx) +  ((b - a) * ry) + ((CLUT[base4] - b) * rz));

            if(interpK) {
                base1+=kOffset;
                base2+=kOffset;
                base4+=kOffset;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[0] = (o0 + (((d0 + ((a - d0) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o0) * rk)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[1] = (o1 + (((d1 + ((a - d1) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o1) * rk)) * outputScale;

                a = CLUT[base1];
                b = CLUT[base2];
                output[2] = (o2 + (((d2 + ((a - d2) * rx) + ((b - a) * ry) + ((CLUT[base4] - b) * rz)) - o2) * rk)) * outputScale;

            } else {
                output[0] = o0 * outputScale;
                output[1] = o1 * outputScale;
                output[2] = o2 * outputScale;
            }

        } else if (rx >= rz && rz >= ry) {
            // block2

            base1 = X1 + Y0 + Z0 + K0;
            base2 = X1 + Y1 + Z1 + K0;
            base3 = X1 + Y0 + Z1 + K0;
            //base4 = base3;
            //base5 = base1;

            a = CLUT[base3++];
            b = CLUT[base1++];
            o0 = c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);

            a = CLUT[base3++];
            b = CLUT[base1++];
            o1 = c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);

            a = CLUT[base3];
            b = CLUT[base1];
            o2 = c2 + ((b - c2) * rx) + ((CLUT[base2] - a) * ry) + ((a - b) * rz);


            if(interpK) {
                base3 += kOffset;
                base1 += kOffset;
                base2 += kOffset;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[0] = (o0 + ((( d0 + ((b - d0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[1] = (o1 + ((( d1 + ((b - d1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                a = CLUT[base3];
                b = CLUT[base1];
                output[2] = (o2 + ((( d2 + ((b - d2) * rx) + ((CLUT[base2] - a) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

            } else {
                output[0] = o0 * outputScale;
                output[1] = o1 * outputScale;
                output[2] = o2 * outputScale;
            }

        } else if (rx >= ry && rz >= rx) {
            // block3

            base1 = X1 + Y0 + Z1 + K0;
            base2 = X0 + Y0 + Z1 + K0;
            base3 = X1 + Y1 + Z1 + K0;
            //base4 = base1;
            //base5 = base2;

            a = CLUT[base1++];
            b = CLUT[base2++];
            o0 = c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz);

            a = CLUT[base1++];
            b = CLUT[base2++];
            o1 = c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz);

            a = CLUT[base1];
            b = CLUT[base2];
            o2 = c2 + ((a - b) * rx) + ((CLUT[base3] - a) * ry) + ((b - c2) * rz);

            if(interpK) {
                base1 += kOffset;
                base2 += kOffset;
                base3 += kOffset;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[0] = (o0 + ((( d0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - d0) * rz) ) - o0) * rk)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[1] = (o1 + ((( d1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - d1) * rz) ) - o1) * rk)) * outputScale;

                a = CLUT[base1];
                b = CLUT[base2];
                output[2] = (o2 + ((( d2 + ((a - b) * rx) + ((CLUT[base3] - a) * ry) + ((b - d2) * rz) ) - o2) * rk)) * outputScale;
            } else {
                output[0] = o0 * outputScale;
                output[1] = o1 * outputScale;
                output[2] = o2 * outputScale;
            }

        } else if (ry >= rx && rx >= rz) {
            // block4

            base1 = X1 + Y1 + Z0 + K0;
            base2 = X0 + Y1 + Z0 + K0;
            //base3 = base2;
            base4 = X1 + Y1 + Z1 + K0;
            //base5 = base1;

            a = CLUT[base2++];
            b = CLUT[base1++];
            o0 = c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz);

            a = CLUT[base2++];
            b = CLUT[base1++];
            o1 = c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz);

            a = CLUT[base2];
            b = CLUT[base1];
            o2 = c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4] - b) * rz);


            if(interpK) {
                base1 += kOffset;
                base2 += kOffset;
                base4 += kOffset;

                a = CLUT[base2++];
                b = CLUT[base1++];
                output[0] = (o0 + ((( d0 + ((b - a) * rx) + ((a - d0) * ry) + ((CLUT[base4++] - b) * rz) ) - o0) * rk)) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base1++];
                output[1] = (o1 + ((( d1 + ((b - a) * rx) + ((a - d1) * ry) + ((CLUT[base4++] - b) * rz) ) - o1) * rk)) * outputScale;

                a = CLUT[base2];
                b = CLUT[base1];
                output[2] = (o2 + ((( d2 + ((b - a) * rx) + ((a - d2) * ry) + ((CLUT[base4] - b) * rz) ) - o2) * rk)) * outputScale;

            } else {
                output[0] = o0 * outputScale;
                output[1] = o1 * outputScale;
                output[2] = o2 * outputScale;
            }

        } else if (ry >= rz && rz >= rx) {
            // block5

            base1 = X1 + Y1 + Z1 + K0;
            base2 = X0 + Y1 + Z1 + K0;
            base3 = X0 + Y1 + Z0 + K0;
            //base4 = base2;
            //base5 = base3;

            a = CLUT[base2++];
            b = CLUT[base3++];
            o0 = c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz);

            a = CLUT[base2++];
            b = CLUT[base3++];
            o1 = c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz);

            a = CLUT[base2];
            b = CLUT[base3];
            o2 = c2 + ((CLUT[base1] - a) * rx) + ((b - c2) * ry) + ((a - b) * rz);


            if(interpK) {
                base1 += kOffset;
                base2 += kOffset;
                base3 += kOffset;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[0] = (o0 + ((( d0 + ((CLUT[base1++] - a) * rx) + ((b - d0) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[1] = (o1 + ((( d1 + ((CLUT[base1++] - a) * rx) + ((b - d1) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                a = CLUT[base2];
                b = CLUT[base3];
                output[2] = (o2 + ((( d2 + ((CLUT[base1] - a) * rx) + ((b - d2) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

            } else {
                output[0] = o0 * outputScale;
                output[1] = o1 * outputScale;
                output[2] = o2 * outputScale;
            }

        } else if (rz >= ry && ry >= rx) {
            // block6

            base1 = X1 + Y1 + Z1 + K0;
            base2 = X0 + Y1 + Z1 + K0;
            //base3 = base2;
            base4 = X0 + Y0 + Z1 + K0;
            //base5 = base4;

            a = CLUT[base2++]
            b = CLUT[base4++]
            o0 = c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz) ;

            a = CLUT[base2++]
            b = CLUT[base4++]
            o1 = c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz);

            a = CLUT[base2]
            b = CLUT[base4]
            o2 = c2 + ((CLUT[base1] - a) * rx) + ((a - b) * ry) + ((b - c2) * rz);

            if(interpK) {
                base1 += kOffset;
                base2 += kOffset;
                base4 += kOffset;

                a = CLUT[base2++]
                b = CLUT[base4++]
                output[0] = (o0 + ((( d0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - d0) * rz) ) - o0) * rk)) * outputScale;

                a = CLUT[base2++]
                b = CLUT[base4++]
                output[1] = (o1 + ((( d1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - d1) * rz) ) - o1) * rk)) * outputScale;

                a = CLUT[base2]
                b = CLUT[base4]
                output[2] = (o2 + ((( d2 + ((CLUT[base1] - a) * rx) + ((a - b) * ry) + ((b - d2) * rz) ) - o2) * rk)) * outputScale;

            } else {
                output[0] = o0 * outputScale;
                output[1] = o1 * outputScale;
                output[2] = o2 * outputScale;
            }

        } else {
            if(interpK) {
                output[0] = c0 + (( d0 - c0 ) * rk) * outputScale;
                output[1] = c1 + (( d1 - c1 ) * rk) * outputScale;
                output[2] = c2 + (( d2 - c2 ) * rk) * outputScale;
            } else {
                output[0] = c0 * outputScale;
                output[1] = c1 * outputScale;
                output[2] = c2 * outputScale;
            }
        }
        return output;
    };

    /**
     * 4D tetrahedral interpolation, 4-channel input → 4-channel output.
     * Accuracy path. Used for CMYK → CMYK single-colour conversions (DeviceLink
     * application, press-to-press re-purposing analysis).
     *
     * Same K-axis early-out as the 4D→3Ch variant.
     *
     * @param {number[]} input  [k, c, m, y] in 0..1 (input[0] is the K axis).
     * @param {object}   lut
     * @returns {number[]}      [c, m, y, k] scaled to lut.outputScale.
     */
    tetrahedralInterp4D_4Ch(input, lut){
        var X0, X1, Y0, K0,
            Y1, Z0, Z1,
            rx, ry, rz, rk,
            px, py, pz, pk,
            input0, input1, input2, inputK,
            base1, base2, base3, base4,
            c0, c1, c2, c3,
            o0, o1, o2, o3,
            k0, k1, k2, k3,
            a, b,
            interpK;

        var outputScale = lut.outputScale;

        var gridEnd = (lut.g1 - 1);
        var gridPointsScale = gridEnd * lut.inputScale;
        var CLUT = lut.CLUT;
        var go0 = lut.go0;
        var go1 = lut.go1;
        var go2 = lut.go2;
        var go3 = lut.go3;
        var kOffset = go3 - lut.outputChannels + 1; // +1 since we don't do a [base++] for the last CLUT lookup

        // We need some clipping here
        inputK = Math.min(1,Math.max(0 , input[0])); // K
        input0 = Math.min(1,Math.max(0 , input[1])); // C
        input1 = Math.min(1,Math.max(0 , input[2])); // M
        input2 = Math.min(1,Math.max(0 , input[3])); // Y

        px = input0 * gridPointsScale;
        py = input1 * gridPointsScale;
        pz = input2 * gridPointsScale;
        pk = inputK * gridPointsScale;

        K0 = ~~pk;
        rk = (pk - K0);
        interpK = !(K0 === gridEnd)// K0 and K1 are identical if K0 is the last grid point
        K0 *= go3;
        // No need to calc K1 as we will add kOffset to the base location to get the K1 location

        X0 = ~~px; //~~ is the same as Math.floor(px)
        rx = (px - X0); // get the fractional part
        if(X0 === gridEnd){
            X1 = X0 *= go2;// change to index in array
        } else {
            X0 *= go2;
            X1 = X0 + go2;
        }

        Y0 = ~~py;
        ry = (py - Y0);
        if(Y0 === gridEnd){
            Y1 = Y0 *= go1;
        } else {
            Y0 *= go1;
            Y1 = Y0 + go1;
        }

        Z0 = ~~pz;
        rz = (pz - Z0);
        if(Z0 === gridEnd){
            Z1 = Z0 *= go0;
        } else {
            Z0 *= go0;
            Z1 = Z0 + go0;
        }

        base1 = X0 + Y0 + Z0 + K0;
        c0 = CLUT[base1++];
        c1 = CLUT[base1++];
        c2 = CLUT[base1++];
        c3 = CLUT[base1];

        if(interpK) {
            base1 +=kOffset;
            k0 = CLUT[base1++];
            k1 = CLUT[base1++];
            k2 = CLUT[base1++];
            k3 = CLUT[base1];
        }

        var output = new Array(4);

        if (rx >= ry && ry >= rz) {
            // block1
            base1 = X1 + Y0 + Z0 + K0;
            base2 = X1 + Y1 + Z0 + K0;
            //base3 = base1; SAME AS base1
            base4 = X1 + Y1 + Z1 + K0;
            //base5 = base2; SAME as base2

            // Note that baseN is increased after each read from the array to move to the next channel
            a = CLUT[base1++];
            b = CLUT[base2++];
            o0 = (c0 + ((a - c0) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz));

            a = CLUT[base1++];
            b = CLUT[base2++];
            o1 = (c1 + ((a - c1) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz));

            a = CLUT[base1++];
            b = CLUT[base2++];
            o2 = (c2 + ((a - c2) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz));

            a = CLUT[base1];
            b = CLUT[base2];
            o3 = (c3 + ((a - c3) * rx) +  ((b - a) * ry) + ((CLUT[base4] - b) * rz));

            if(interpK) {
                base1+=kOffset;
                base2+=kOffset;
                base4+=kOffset;

                a = CLUT[base1++];
                b = CLUT[base2++];
                //output[outputPos++] = c1 + (( d1 - c1 ) * rk)
                output[0] = (o0 + (((k0 + ((a - k0) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o0) * rk)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[1] = (o1 + (((k1 + ((a - k1) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o1) * rk)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[2] = (o2 + (((k2 + ((a - k2) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o2) * rk)) * outputScale;

                a = CLUT[base1];
                b = CLUT[base2];
                output[3] = (o3 + (((k3 + ((a - k3) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o3) * rk)) * outputScale;
            } else {
                output[0] = o0 * outputScale;
                output[1] = o1 * outputScale;
                output[2] = o2 * outputScale;
                output[3] = o3 * outputScale;
            }

        } else if (rx >= rz && rz >= ry) {
            // block2

            base1 = X1 + Y0 + Z0 + K0;
            base2 = X1 + Y1 + Z1 + K0;
            base3 = X1 + Y0 + Z1 + K0;
            //base4 = base3;
            //base5 = base1;

            a = CLUT[base3++];
            b = CLUT[base1++];
            o0 = c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);

            a = CLUT[base3++];
            b = CLUT[base1++];
            o1 = c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);

            a = CLUT[base3++];
            b = CLUT[base1++];
            o2 = c2 + ((b - c2) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);

            a = CLUT[base3];
            b = CLUT[base1];
            o3 = c3 + ((b - c3) * rx) + ((CLUT[base2] - a) * ry) + ((a - b) * rz);

            if(interpK) {
                base3 += kOffset;
                base1 += kOffset;
                base2 += kOffset;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[0] = (o0 + ((( k0 + ((b - k0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[1] = (o1 + ((( k1 + ((b - k1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[2] = (o2 + ((( k2 + ((b - k2) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[3] = (o3 + ((( k3 + ((b - k3) * rx) + ((CLUT[base2  ] - a) * ry) + ((a - b) * rz) ) - o3) * rk)) * outputScale;
            } else {
                output[0] = o0 * outputScale;
                output[1] = o1 * outputScale;
                output[2] = o2 * outputScale;
                output[3] = o3 * outputScale;
            }

        } else if (rx >= ry && rz >= rx) {
            // block3

            base1 = X1 + Y0 + Z1 + K0;
            base2 = X0 + Y0 + Z1 + K0;
            base3 = X1 + Y1 + Z1 + K0;
            //base4 = base1;
            //base5 = base2;

            a = CLUT[base1++];
            b = CLUT[base2++];
            o0 = c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz);

            a = CLUT[base1++];
            b = CLUT[base2++];
            o1 = c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz);

            a = CLUT[base1++];
            b = CLUT[base2++];
            o2 = c2 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c2) * rz);

            a = CLUT[base1];
            b = CLUT[base2];
            o3 = c3 + ((a - b) * rx) + ((CLUT[base3] - a) * ry) + ((b - c3) * rz);

            if(interpK) {
                base1 += kOffset;
                base2 += kOffset;
                base3 += kOffset;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[0] = (o0 + ((( k0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - k0) * rz) ) - o0) * rk)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[1] = (o1 + ((( k1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - k1) * rz) ) - o1) * rk)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[2] = (o2 + ((( k2 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - k2) * rz) ) - o2) * rk)) * outputScale;

                a = CLUT[base1];
                b = CLUT[base2];
                output[3] = (o3 + ((( k3 + ((a - b) * rx) + ((CLUT[base3  ] - a) * ry) + ((b - k3) * rz) ) - o3) * rk)) * outputScale;
            } else {
                output[0] = o0 * outputScale;
                output[1] = o1 * outputScale;
                output[2] = o2 * outputScale;
                output[3] = o3 * outputScale;
            }

        } else if (ry >= rx && rx >= rz) {
            // block4

            base1 = X1 + Y1 + Z0 + K0;
            base2 = X0 + Y1 + Z0 + K0;
            //base3 = base2;
            base4 = X1 + Y1 + Z1 + K0;
            //base5 = base1;

            a = CLUT[base2++];
            b = CLUT[base1++];
            o0 = c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz);

            a = CLUT[base2++];
            b = CLUT[base1++];
            o1 = c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz);

            a = CLUT[base2++];
            b = CLUT[base1++];
            o2 = c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4++] - b) * rz);

            a = CLUT[base2];
            b = CLUT[base1];
            o3 = c3 + ((b - a) * rx) + ((a - c3) * ry) + ((CLUT[base4] - b) * rz);

            if(interpK) {
                base1 += kOffset;
                base2 += kOffset;
                base4 += kOffset;

                a = CLUT[base2++];
                b = CLUT[base1++];
                output[0] = (o0 + ((( k0 + ((b - a) * rx) + ((a - k0) * ry) + ((CLUT[base4++] - b) * rz) ) - o0) * rk)) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base1++];
                output[1] = (o1 + ((( k1 + ((b - a) * rx) + ((a - k1) * ry) + ((CLUT[base4++] - b) * rz) ) - o1) * rk)) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base1++];
                output[2] = (o2 + ((( k2 + ((b - a) * rx) + ((a - k2) * ry) + ((CLUT[base4++] - b) * rz) ) - o2) * rk)) * outputScale;

                a = CLUT[base2];
                b = CLUT[base1];
                output[3] = (o3 + ((( k3 + ((b - a) * rx) + ((a - k3) * ry) + ((CLUT[base4  ] - b) * rz) ) - o3) * rk)) * outputScale;
            } else {
                output[0] = o0 * outputScale;
                output[1] = o1 * outputScale;
                output[2] = o2 * outputScale;
                output[3] = o3 * outputScale;
            }

        } else if (ry >= rz && rz >= rx) {
            // block5

            base1 = X1 + Y1 + Z1 + K0;
            base2 = X0 + Y1 + Z1 + K0;
            base3 = X0 + Y1 + Z0 + K0;
            //base4 = base2;
            //base5 = base3;

            a = CLUT[base2++];
            b = CLUT[base3++];
            o0 = c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz);

            a = CLUT[base2++];
            b = CLUT[base3++];
            o1 = c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz);

            a = CLUT[base2++];
            b = CLUT[base3++];
            o2 = c2 + ((CLUT[base1++] - a) * rx) + ((b - c2) * ry) + ((a - b) * rz);

            a = CLUT[base2];
            b = CLUT[base3];
            o3 = c3 + ((CLUT[base1] - a) * rx) + ((b - c3) * ry) + ((a - b) * rz);

            if(interpK) {
                base1 += kOffset;
                base2 += kOffset;
                base3 += kOffset;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[0] = (o0 + ((( k0 + ((CLUT[base1++] - a) * rx) + ((b - k0) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[1] = (o1 + ((( k1 + ((CLUT[base1++] - a) * rx) + ((b - k1) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[2] = (o2 + ((( k2 + ((CLUT[base1++] - a) * rx) + ((b - k2) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

                a = CLUT[base2];
                b = CLUT[base3];
                output[3] = (o3 + ((( k3 + ((CLUT[base1++] - a) * rx) + ((b - k3) * ry) + ((a - b) * rz) ) - o3) * rk)) * outputScale;
            } else {
                output[0] = o0 * outputScale;
                output[1] = o1 * outputScale;
                output[2] = o2 * outputScale;
                output[3] = o3 * outputScale;
            }

        } else if (rz >= ry && ry >= rx) {
            // block6

            base1 = X1 + Y1 + Z1 + K0;
            base2 = X0 + Y1 + Z1 + K0;
            //base3 = base2;
            base4 = X0 + Y0 + Z1 + K0;
            //base5 = base4;

            a = CLUT[base2++]
            b = CLUT[base4++]
            o0 = c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz) ;

            a = CLUT[base2++]
            b = CLUT[base4++]
            o1 = c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz);

            a = CLUT[base2++]
            b = CLUT[base4++]
            o2 = c2 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c2) * rz);

            a = CLUT[base2]
            b = CLUT[base4]
            o3 = c3 + ((CLUT[base1] - a) * rx) + ((a - b) * ry) + ((b - c3) * rz);

            if(interpK) {
                base1 += kOffset;
                base2 += kOffset;
                base4 += kOffset;

                a = CLUT[base2++]
                b = CLUT[base4++]
                output[0] = (o0 + ((( k0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - k0) * rz) ) - o0) * rk)) * outputScale;

                a = CLUT[base2++]
                b = CLUT[base4++]
                output[1] = (o1 + ((( k1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - k1) * rz) ) - o1) * rk)) * outputScale;

                a = CLUT[base2++]
                b = CLUT[base4++]
                output[2] = (o2 + ((( k2 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - k2) * rz) ) - o2) * rk)) * outputScale;

                a = CLUT[base2]
                b = CLUT[base4]
                output[3] = (o3 + ((( k3 + ((CLUT[base1  ] - a) * rx) + ((a - b) * ry) + ((b - k3) * rz) ) - o3) * rk)) * outputScale;
            } else {
                output[0] = o0 * outputScale;
                output[1] = o1 * outputScale;
                output[2] = o2 * outputScale;
                output[3] = o3 * outputScale;
            }

        } else {
            if(interpK) {
                output[0] = c0 + (( k0 - c0 ) * rk) * outputScale;
                output[1] = c1 + (( k1 - c1 ) * rk) * outputScale;
                output[2] = c2 + (( k2 - c2 ) * rk) * outputScale;
                output[3] = c3 + (( k3 - c3 ) * rk) * outputScale;
            } else {
                output[0] = c0 * outputScale;
                output[1] = c1 * outputScale;
                output[2] = c2 * outputScale;
                output[3] = c3 * outputScale;
            }
        }
        return output;
    };

    /**
     * 4D tetrahedral interpolation, 4-channel input → N-channel output
     * (typically N >= 5 — n-color separations from a CMYK source).
     * Accuracy path.
     *
     * For the common 4→3 (CMYK→RGB / Lab) and 4→4 (CMYK→CMYK) cases the
     * unrolled tetrahedralInterp4D_3Ch / _4Ch variants above are dispatched
     * by addStageLUT() instead.
     *
     * @param {number[]} input  4 channels in 0..1.
     * @param {object}   lut
     * @returns {number[]}      New array of length lut.outputChannels.
     */
    tetrahedralInterp4D_NCh(input, lut){
        var X0, X1, Y0, K0,
            Y1, Z0, Z1,
            rx, ry, rz, rk,
            px, py, pz, pk,
            input0, input1, input2, inputK,
            base0, base1, base2, base3, base4,
            a, b, c, d, o,
            interpK;

        var outputScale = lut.outputScale;
        var gridEnd = (lut.g1 - 1);
        var gridPointsScale = gridEnd * lut.inputScale;
        var outputChannels = lut.outputChannels;
        var CLUT = lut.CLUT;
        var go0 = lut.go0;
        var go1 = lut.go1;
        var go2 = lut.go2;
        var go3 = lut.go3;
        var kOffset = go3 - lut.outputChannels;

        inputK = Math.min(1, Math.max(0, input[0])); // K
        input0 = Math.min(1, Math.max(0, input[1])); // C
        input1 = Math.min(1, Math.max(0, input[2])); // M
        input2 = Math.min(1, Math.max(0, input[3])); // Y

        px = input0 * gridPointsScale;
        py = input1 * gridPointsScale;
        pz = input2 * gridPointsScale;
        pk = inputK * gridPointsScale;

        K0 = ~~pk;
        rk = (pk - K0);
        interpK = !(K0 === gridEnd)// K0 and K1 are identical if K0 is the last grid point
        K0 *= go3;
        // No need to calc K1 as we will add kOffset to the base location to get the K1 location

        X0 = ~~px; //~~ is the same as Math.floor(px)
        rx = (px - X0); // get the fractional part
        if(X0 === gridEnd){
            X1 = X0 *= go2;// change to index in array
        } else {
            X0 *= go2;
            X1 = X0 + go2;
        }

        Y0 = ~~py;
        ry = (py - Y0);
        if(Y0 === gridEnd){
            Y1 = Y0 *= go1;
        } else {
            Y0 *= go1;
            Y1 = Y0 + go1;
        }

        Z0 = ~~pz;
        rz = (pz - Z0);
        if(Z0 === gridEnd){
            Z1 = Z0 *= go0;
        } else {
            Z0 *= go0;
            Z1 = Z0 + go0;
        }

        var outputScaleK0 = (interpK) ? 1 : outputScale

        base0 = X0 + Y0 + Z0 + K0;

        var output = new Array(outputChannels);

        if (rx >= ry && ry >= rz) {
            // block1
            base1 = X1 + Y0 + Z0 + K0;
            base2 = X1 + Y1 + Z0 + K0;
            base4 = X1 + Y1 + Z1 + K0;

            // Read in K0, If K1 is needed outputScaleK0 = 1, else outputScaleK0 = outputScale
            for(o = 0 ; o < outputChannels ; o++) {
                a = CLUT[base1++];
                b = CLUT[base2++];
                c = CLUT[base0++];
                output[o] = (c + ((a - c) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScaleK0;
            }

            // Only interpolate K1 if needed, K1 is the next n items in the LUT
            if(interpK) {
                base0 += kOffset;
                base1 += kOffset;
                base2 += kOffset;
                base4 += kOffset;
                for(o = 0 ; o < outputChannels ; o++) {
                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    c = CLUT[base0++];
                    d = output[o]; // get the output from the previous loop to interpolate
                    output[o] = (d + (((c + ((a - c) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - d) * rk)) * outputScale;
                }
            }

        } else if (rx >= rz && rz >= ry) {
            // block2

            base1 = X1 + Y0 + Z0 + K0;
            base2 = X1 + Y1 + Z1 + K0;
            base3 = X1 + Y0 + Z1 + K0;
            for(o = 0 ; o < outputChannels ; o++) {
                a = CLUT[base3++];
                b = CLUT[base1++];
                c = CLUT[base0++];
                output[o] = (c + ((b - c) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz)) * outputScaleK0;
            }

            if(interpK) {
                base0 += kOffset;
                base1 += kOffset;
                base2 += kOffset;
                base3 += kOffset;
                for(o = 0 ; o < outputChannels ; o++) {
                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    c = CLUT[base0++];
                    d = output[o];
                    output[o] = (d + ((( c + ((b - c) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - d) * rk)) * outputScale;
                }
            }

        } else if (rx >= ry && rz >= rx) {
            // block3

            base1 = X1 + Y0 + Z1 + K0;
            base2 = X0 + Y0 + Z1 + K0;
            base3 = X1 + Y1 + Z1 + K0;
            for(o = 0 ; o < outputChannels ; o++) {
                a = CLUT[base1++];
                b = CLUT[base2++];
                c = CLUT[base0++];
                output[o] = (c + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c) * rz)) * outputScaleK0;
            }

            if(interpK) {
                base0 += kOffset;
                base1 += kOffset;
                base2 += kOffset;
                base3 += kOffset;

                for(o = 0 ; o < outputChannels ; o++) {
                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    c = CLUT[base0++];
                    d = output[o];
                    output[o] = (d + ((( c + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c) * rz) ) - d) * rk)) * outputScale;
                }
            }

        } else if (ry >= rx && rx >= rz) {
            // block4

            base1 = X1 + Y1 + Z0 + K0;
            base2 = X0 + Y1 + Z0 + K0;
            base4 = X1 + Y1 + Z1 + K0;
            for(o = 0 ; o < outputChannels ; o++) {
                a = CLUT[base2++];
                b = CLUT[base1++];
                c = CLUT[base0++];
                output[o] = (c + ((b - a) * rx) + ((a - c) * ry) + ((CLUT[base4++] - b) * rz)) * outputScaleK0;
            }

            if(interpK) {
                base0 += kOffset;
                base1 += kOffset;
                base2 += kOffset;
                base4 += kOffset;
                for(o = 0 ; o < outputChannels ; o++) {
                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    c = CLUT[base0++];
                    d = output[o];
                    output[o] = (d + (((c + ((b - a) * rx) + ((a - c) * ry) + ((CLUT[base4++] - b) * rz) ) - d) * rk)) * outputScale;
                }
            }

        } else if (ry >= rz && rz >= rx) {
            // block5

            base1 = X1 + Y1 + Z1 + K0;
            base2 = X0 + Y1 + Z1 + K0;
            base3 = X0 + Y1 + Z0 + K0;
            for(o = 0 ; o < outputChannels ; o++) {
                a = CLUT[base2++];
                b = CLUT[base3++];
                c = CLUT[base0++];
                output[o] = (c + ((CLUT[base1++] - a) * rx) + ((b - c) * ry) + ((a - b) * rz)) * outputScaleK0;
            }

            if(interpK) {
                base0 += kOffset;
                base1 += kOffset;
                base2 += kOffset;
                base3 += kOffset;
                for(o = 0 ; o < outputChannels ; o++) {
                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    c = CLUT[base0++];
                    d = output[o];
                    output[o] = (d + ((( c + ((CLUT[base1++] - a) * rx) + ((b - c) * ry) + ((a - b) * rz) ) - d) * rk)) * outputScale;
                }
            }

        } else if (rz >= ry && ry >= rx) {
            // block6

            base1 = X1 + Y1 + Z1 + K0;
            base2 = X0 + Y1 + Z1 + K0;
            base4 = X0 + Y0 + Z1 + K0;

            for(o = 0 ; o < outputChannels ; o++) {
                a = CLUT[base2++];
                b = CLUT[base4++];
                c = CLUT[base0++];
                output[o] = (c + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c) * rz)) * outputScaleK0;
            }

            if(interpK) {
                base0 += kOffset;
                base1 += kOffset;
                base2 += kOffset;
                base4 += kOffset;
                for(o = 0 ; o < outputChannels ; o++) {
                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    c = CLUT[base0++]
                    d = output[o];
                    output[o] = (d + ((( c + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c) * rz) ) - d) * rk)) * outputScale;
                }
            }

        } else {
            if(interpK) {
                for(o = 0 ; o < outputChannels ; o++) {
                    output[o] = CLUT[base0++];
                }
                base0 += kOffset;
                for(o = 0 ; o < outputChannels ; o++) {
                    c = CLUT[base0++]
                    output[o] = (c + (( output[o] - c ) * rk)) * outputScale;
                }
            } else {
                for(o = 0 ; o < outputChannels ; o++) {
                    output[o] = CLUT[base0++] * outputScale;
                }
            }
        }

        return output;
    };


    /* ========================================================================
     *  HOT PATH — image-grade pixel loops
     * ========================================================================
     *
     *  The functions below (linearInterp1DArray_NCh_loop, bilinearInterp2D...,
     *  tetrahedralInterp3DArray_3Ch / 4Ch / NCh _loop, tetrahedralInterp4D...
     *  _loop) are the inner loops used by transformArrayViaLUT(). They are
     *  called once per IMAGE — not once per pixel — and the per-pixel loop is
     *  inside the function body. On a 4 MP image, the body runs 4,000,000
     *  times per call. Several deliberate trade-offs apply across all of
     *  them; resist the temptation to "tidy up":
     *
     *  1. NO BOUNDS CHECKS on input data.
     *     Caller guarantees a Uint8ClampedArray of well-formed pixel data
     *     (values 0..255, length === pixelCount * channelsPerPixel). Adding
     *     `if (x < 0 || x > 255)` per channel adds tens of millions of
     *     branches per image — measured to dominate runtime. If you need
     *     validation, use the per-colour `forward()` accuracy path instead.
     *
     *  2. ALL ARITHMETIC INLINED into single expressions.
     *     Saving partial results to temporary variables MEASURABLY tanks
     *     performance — both V8 and SpiderMonkey spill values to memory
     *     instead of keeping them in xmm registers between operations. The
     *     unrolled, ugly-looking single-line expressions are the fast form.
     *     See "PERFORMANCE LESSONS" comment further down in this file.
     *
     *  3. THE 6 OCTANT BRANCHES ARE FULLY UNROLLED.
     *     There are 6 nearly-identical octant blocks per function, with
     *     small inner unrolls per output channel. Combined across
     *     {3D,4D} × {3Ch,4Ch,NCh} × {single-color, _loop}, the same algorithm
     *     is duplicated ~12 times. Bug fixes must be applied to ALL copies.
     *     TODO: codegen these from a single template (see issue / TODO P7).
     *
     *  4. NO PER-PIXEL ALLOCATIONS.
     *     Output is written directly into `output[outputPos++]`. The single-
     *     colour interpolators above (e.g. tetrahedralInterp3D_3Ch) allocate
     *     a small Array per call — that's fine for the accuracy path but
     *     would dominate cost here, hence the inlined loop variants.
     *
     *  5. THE STAGE PIPELINE IS COLLAPSED INTO ONE STEP.
     *     transformArrayViaLUT does NOT walk this.pipeline per pixel; the
     *     prebuilt LUT already encodes the full pipeline including any
     *     custom stages and BPC. This is the reason this path is 20–30×
     *     faster than the accuracy path.
     *
     *  KNOWN ISSUES / TODOs in the loops below
     *  ----------------------------------------------------------------------
     *
     *   B2.  The `(input0 === 255)` upper-edge clamp is correct only for
     *        8-bit input. The planned _loop_16bit variants (currently
     *        commented-out at the routing switch in transformArrayViaLUT)
     *        will need to be `(X0 === gridEnd)` instead — same speed, type-
     *        independent. Apply to all 6 unrolled `_loop` functions when
     *        re-enabling the 16-bit path.
     *
     *   B3.  linearInterp1DArray_NCh_loop / bilinearInterp2DArray_NCh_loop /
     *        tetrahedralInterp3DArray_NCh_loop / tetrahedralInterp4DArray_NCh_loop
     *        currently DELEGATE to the single-colour interpolator and copy
     *        the result, allocating ~2 small arrays per pixel. They should
     *        be inlined the same way the 3Ch and 4Ch variants are. This is
     *        the only real Tier-A perf bug remaining; affects exotic channel
     *        counts (Gray→4ch, Duo→Nch, RGB→{2,5,6,7,8}, CMYK→Nch).
     *
     *   P4.  Each call allocates a fresh Uint8ClampedArray for the output.
     *        For real-time soft-proofing of video / repeated canvas redraws
     *        consider an optional `out` parameter on transformArrayViaLUT.
     *
     *  TESTING
     *  ----------------------------------------------------------------------
     *  If you change anything in this section, re-run BOTH:
     *      __tests__/lcms.tests.js          (numerical accuracy vs LittleCMS)
     *      speed_tests/                     (ns per pixel, before vs after)
     *  Both regress easily — small algebraic rewrites can introduce 1-LSB
     *  errors that fail the LCMS comparison, and "harmless" extracts to
     *  intermediate variables can halve throughput.
     * ========================================================================
     */

    /**
     * HOT PATH. 3D LUT, 3-channel input → 4-channel output.
     * Typical use: RGB → CMYK image conversion.
     * See HOT PATH header above for the contract and trade-offs that apply
     * to all functions in this group.
     */
    tetrahedralInterp3DArray_4Ch_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
        var rx,ry,rz;
        var X0,X1,Y0,Y1,Z0,Z1,px,py,pz, input0, input1, input2
        var base1,base2, base3, base4,
            c0,c1,c2,c3, a, b

        var outputScale = lut.outputScale;
        var gridPointsScale = (lut.g1 - 1) * lut.inputScale;
        var CLUT = lut.CLUT;
        var go0 = lut.go0;
        var go1 = lut.go1;
        var go2 = lut.go2;

        for(var p = 0; p < length; p++) {

            // We need some clipping here
            input0 = input[inputPos++];
            input1 = input[inputPos++];
            input2 = input[inputPos++];

            // No clipping checks for speed needed for clamped arrays

            // Rather than divide input by 255 then multiply by (lut.g1 - 1)
            // Just do this once, this means input0 stays an int and
            // only px needs to be a float
            px = input0 * gridPointsScale;
            py = input1 * gridPointsScale;
            pz = input2 * gridPointsScale;

            //
            // A few optimisations here, X0 is multiplied by go2, which is precalculated grid x outputChannels
            // Keeping input0 as int means we can just check input0 === 255 rather than input0 >= 1.0 as a float
            // And rather than X0+1 we can just do X0 + offset to location in lut
            //
            // TODO (B2): The (inputN === 255) upper-edge clamps below are
            // ONLY correct for 8-bit input. The same pattern is duplicated
            // across 6 _loop functions and is reused by the (commented-out)
            // _loop_16bit variants. When re-enabling 16-bit, swap each
            // `(inputN === 255)` for the type-independent `(XN === gridEnd)`
            // (where gridEnd = lut.g1 - 1) in ALL copies. Same speed.
            X0 = ~~px; //~~ is the same as Math.floor(px)
            rx = (px - X0); // get the fractional part
            X0 *= go2; // change to index in array
            X1 = (input0 === 255) ? X0 : X0 + go2; // work out next index

            Y0 = ~~py;
            ry = (py - Y0);
            Y0 *= go1;
            Y1 = (input1 === 255) ? Y0 : Y0 + go1;

            Z0 = ~~pz;
            rz = (pz - Z0);
            Z0 *= go0;
            Z1 = (input2 === 255) ? Z0 : Z0 + go0;

            // Starting point in CLUT
            // Note that X0, Y0, Z0 are all multiplied by the grid offset and the outputChannels
            // So we only need additions rather than n = ((X0 * go2) + (Y0 * go1) + Z0)) * outputChannels
            base1 = X0 + Y0 + Z0;
            c0 = CLUT[base1++];
            c1 = CLUT[base1++];
            c2 = CLUT[base1++];
            c3 = CLUT[base1];

            if (rx >= ry && ry >= rz) {
                // block1
                base1 = X1 + Y0 + Z0;
                base2 = X1 + Y1 + Z0;
                //base3 = base1; SAME AS base1
                base4 = X1 + Y1 + Z1;
                //base5 = base2; SAME as base2

                // Important performance issues noted in Chrome and Firefox, assigning intermediate variables slows things down a lot
                // Just having one long line of code is much faster, I suspect internally all this math is done in registers,
                // as the JIT can see that variables are not used, so it can just do the math and store the result
                // If we were to use intermediate variables forces the compiler to read/write memory and potentially trigger the GC
                // However using a/b below to read only once from the array does appear to be faster, The less memory reads the better
                //
                // Note that baseN is increased after each read from the array to move to the next channel
                a = CLUT[base1++];
                b = CLUT[base2++];
                output[outputPos++] = (c0 + ((a - c0) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[outputPos++] = (c1 + ((a - c1) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[outputPos++] = (c2 + ((a - c2) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

                // Duno if this helps, but no need to increase base1/2/3/4 again as we are done with them
                a = CLUT[base1  ];
                b = CLUT[base2  ];
                output[outputPos++] = (c3 + ((a - c3) * rx) +  ((b - a) * ry) + ((CLUT[base4  ] - b) * rz)) * outputScale;

            } else if (rx >= rz && rz >= ry) {
                // block2

                base1 = X1 + Y0 + Z0;
                base2 = X1 + Y1 + Z1;
                base3 = X1 + Y0 + Z1;
                //base4 = base3;
                //base5 = base1;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[outputPos++] =( c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[outputPos++] =( c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[outputPos++] =( c2 + ((b - c2) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base3];
                b = CLUT[base1];
                output[outputPos++] =( c3 + ((b - c3) * rx) + ((CLUT[base2  ] - a) * ry) + ((a - b) * rz) ) * outputScale;

            } else if (rx >= ry && rz >= rx) {
                // block3

                base1 = X1 + Y0 + Z1;
                base2 = X0 + Y0 + Z1;
                base3 = X1 + Y1 + Z1;
                //base4 = base1;
                //base5 = base2;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[outputPos++] = (c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[outputPos++] = (c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[outputPos++] = (c2 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c2) * rz)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[outputPos++] = (c3 + ((a - b) * rx) + ((CLUT[base3  ] - a) * ry) + ((b - c3) * rz)) * outputScale;

            } else if (ry >= rx && rx >= rz) {
                // block4

                base1 = X1 + Y1 + Z0;
                base2 = X0 + Y1 + Z0;
                //base3 = base2;
                base4 = X1 + Y1 + Z1;
                //base5 = base1;

                a = CLUT[base2++];
                b = CLUT[base1++];
                output[outputPos++] = (c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base1++];
                output[outputPos++] = (c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base1++];
                output[outputPos++] = (c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

                a = CLUT[base2];
                b = CLUT[base1];
                output[outputPos++] = (c3 + ((b - a) * rx) + ((a - c3) * ry) + ((CLUT[base4  ] - b) * rz) ) * outputScale;

            } else if (ry >= rz && rz >= rx) {
                // block5

                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                base3 = X0 + Y1 + Z0;
                //base4 = base2;
                //base5 = base3;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[outputPos++] = (c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[outputPos++] = (c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[outputPos++] = (c2 + ((CLUT[base1++] - a) * rx) + ((b - c2) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[outputPos++] = (c3 + ((CLUT[base1++] - a) * rx) + ((b - c3) * ry) + ((a - b) * rz) ) * outputScale;

            } else if (rz >= ry && ry >= rx) {
                // block6

                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                //base3 = base2;
                base4 = X0 + Y0 + Z1;
                //base5 = base4;

                a = CLUT[base2++]
                b = CLUT[base4++]
                output[outputPos++] = (c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz) ) * outputScale;

                a = CLUT[base2++]
                b = CLUT[base4++]
                output[outputPos++] = (c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz) ) * outputScale;

                a = CLUT[base2++]
                b = CLUT[base4++]
                output[outputPos++] = (c2 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c2) * rz) ) * outputScale;

                a = CLUT[base2]
                b = CLUT[base4]
                output[outputPos++] = (c3 + ((CLUT[base1  ] - a) * rx) + ((a - b) * ry) + ((b - c3) * rz) ) * outputScale;

            } else {
                output[outputPos++] = c0 * outputScale;
                output[outputPos++] = c1 * outputScale;
                output[outputPos++] = c2 * outputScale;
                output[outputPos++] = c3 * outputScale;

            }

            if(preserveAlpha) {
                output[outputPos++] = input[inputPos++];
            } else {
                if(inputHasAlpha)  { inputPos++;  }
                if(outputHasAlpha) {
                    output[outputPos++] = 255;
                }
            }

        }
    };

    /**
     * INT HOT PATH. 3D LUT, 3-channel input → 4-channel output.
     * Integer-math sibling of tetrahedralInterp3DArray_4Ch_loop.
     * Used when lutMode='int' is set. Reads 4 LUT values per CLUT
     * lookup (one extra channel write per sub-block vs the 3Ch variant).
     * See INTEGER HOT PATH header above tetrahedralInterp3DArray_3Ch_intLut_loop
     * for the math contract and tuning notes.
     */
    tetrahedralInterp3DArray_4Ch_intLut_loop(input, inputPos, output, outputPos, length, intLut, inputHasAlpha, outputHasAlpha, preserveAlpha){
        var rx = 0|0, ry = 0|0, rz = 0|0;
        var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0;
        var px = 0|0, py = 0|0, pz = 0|0;
        var input0 = 0|0, input1 = 0|0, input2 = 0|0;
        var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
        var c0 = 0|0, c1 = 0|0, c2 = 0|0, c3 = 0|0, a = 0|0, b = 0|0;

        var gps  = intLut.gridPointsScale_fixed | 0;
        var CLUT = intLut.CLUT;
        var go0  = intLut.go0 | 0;
        var go1  = intLut.go1 | 0;
        var go2  = intLut.go2 | 0;
        var maxX = intLut.maxX | 0;
        var maxY = intLut.maxY | 0;
        var maxZ = intLut.maxZ | 0;

        for(var p = 0; p < length; p++) {
            input0 = input[inputPos++];
            input1 = input[inputPos++];
            input2 = input[inputPos++];

            px = Math.imul(input0, gps);
            py = Math.imul(input1, gps);
            pz = Math.imul(input2, gps);

            if (input0 === 255) { X0 = maxX; X1 = maxX; rx = 0; }
            else { X0 = px >>> 16; rx = (px >>> 8) & 0xFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

            if (input1 === 255) { Y0 = maxY; Y1 = maxY; ry = 0; }
            else { Y0 = py >>> 16; ry = (py >>> 8) & 0xFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

            if (input2 === 255) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
            else { Z0 = pz >>> 16; rz = (pz >>> 8) & 0xFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

            base1 = X0 + Y0 + Z0;
            c0 = CLUT[base1++];
            c1 = CLUT[base1++];
            c2 = CLUT[base1++];
            c3 = CLUT[base1];

            if (rx >= ry && ry >= rz) {
                base1 = X1 + Y0 + Z0;
                base2 = X1 + Y1 + Z0;
                base4 = X1 + Y1 + Z1;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = ((c0 + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = ((c1 + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = ((c2 + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base1];   b = CLUT[base2];
                output[outputPos++] = ((c3 + ((Math.imul(a - c3, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            } else if (rx >= rz && rz >= ry) {
                base1 = X1 + Y0 + Z0;
                base2 = X1 + Y1 + Z1;
                base3 = X1 + Y0 + Z1;
                a = CLUT[base3++]; b = CLUT[base1++];
                output[outputPos++] = ((c0 + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base3++]; b = CLUT[base1++];
                output[outputPos++] = ((c1 + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base3++]; b = CLUT[base1++];
                output[outputPos++] = ((c2 + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base3];   b = CLUT[base1];
                output[outputPos++] = ((c3 + ((Math.imul(b - c3, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            } else if (rx >= ry && rz >= rx) {
                base1 = X1 + Y0 + Z1;
                base2 = X0 + Y0 + Z1;
                base3 = X1 + Y1 + Z1;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = ((c0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = ((c1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = ((c2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c2, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = ((c3 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c3, rz) + 0x80) >> 8)) + 0x80) >> 8;
            } else if (ry >= rx && rx >= rz) {
                base1 = X1 + Y1 + Z0;
                base2 = X0 + Y1 + Z0;
                base4 = X1 + Y1 + Z1;
                a = CLUT[base2++]; b = CLUT[base1++];
                output[outputPos++] = ((c0 + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base2++]; b = CLUT[base1++];
                output[outputPos++] = ((c1 + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base2++]; b = CLUT[base1++];
                output[outputPos++] = ((c2 + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base2];   b = CLUT[base1];
                output[outputPos++] = ((c3 + ((Math.imul(b - a, rx) + Math.imul(a - c3, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            } else if (ry >= rz && rz >= rx) {
                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                base3 = X0 + Y1 + Z0;
                a = CLUT[base2++]; b = CLUT[base3++];
                output[outputPos++] = ((c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base2++]; b = CLUT[base3++];
                output[outputPos++] = ((c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base2++]; b = CLUT[base3++];
                output[outputPos++] = ((c2 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base2];   b = CLUT[base3];
                output[outputPos++] = ((c3 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c3, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            } else if (rz >= ry && ry >= rx) {
                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                base4 = X0 + Y0 + Z1;
                a = CLUT[base2++]; b = CLUT[base4++];
                output[outputPos++] = ((c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base2++]; b = CLUT[base4++];
                output[outputPos++] = ((c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base2++]; b = CLUT[base4++];
                output[outputPos++] = ((c2 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base2];   b = CLUT[base4];
                output[outputPos++] = ((c3 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c3, rz) + 0x80) >> 8)) + 0x80) >> 8;
            } else {
                output[outputPos++] = (c0 + 0x80) >> 8;
                output[outputPos++] = (c1 + 0x80) >> 8;
                output[outputPos++] = (c2 + 0x80) >> 8;
                output[outputPos++] = (c3 + 0x80) >> 8;
            }

            if(preserveAlpha) {
                output[outputPos++] = input[inputPos++];
            } else {
                if(inputHasAlpha)  { inputPos++;  }
                if(outputHasAlpha) {
                    output[outputPos++] = 255;
                }
            }
        }
    };

    /**
     * HOT PATH. 1D LUT, 1-channel input → N-channel output.
     * Typical use: Gray → RGB, Gray → CMYK image conversion.
     *
     * TODO (B3): Currently delegates to linearInterp1D_NCh per pixel and
     * allocates a 1-element wrapper array + an output array per pixel. Should
     * be inlined like tetrahedralInterp3DArray_3Ch_loop. Affects throughput
     * on Gray→multichannel image conversions.
     *
     * See HOT PATH header above tetrahedralInterp3DArray_4Ch_loop for the
     * full set of contracts and trade-offs.
     */
    linearInterp1DArray_NCh_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
        var temp, o;
        var outputChannels = lut.outputChannels;
        for(var p = 0; p < length; p++) {
            temp = this.linearInterp1D_NCh([input[inputPos++]], lut)
            for(o = 0; o < outputChannels; o++) {
                output[outputPos++] = temp[o];
            }
            if(preserveAlpha) {
                output[outputPos++] = input[inputPos++];
            } else {
                if(inputHasAlpha)  { inputPos++;  }
                if(outputHasAlpha) {
                    output[outputPos++] = 255;
                }
            }
        }
    };

    /**
     * HOT PATH. 2D LUT, 2-channel input → N-channel output.
     * Typical use: Duotone → RGB / Duotone → CMYK image conversion.
     *
     * TODO (B3): NOT YET fully inlined for speed — currently delegates to
     * bilinearInterp2D_NCh per pixel and allocates an output array each
     * iteration. Should be inlined like tetrahedralInterp3DArray_3Ch_loop.
     *
     * See HOT PATH header above tetrahedralInterp3DArray_4Ch_loop for the
     * full set of contracts and trade-offs.
     */
    bilinearInterp2DArray_NCh_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
        var colorIn, temp, o;
        var outputChannels = lut.outputChannels;
        colorIn = new Uint8ClampedArray(2);
        for(var p = 0; p < length; p++) {
            colorIn[0] = input[inputPos++];
            colorIn[1] = input[inputPos++];
            temp = this.bilinearInterp2D_NCh(colorIn, lut)
            for(o = 0; o < outputChannels; o++) {
                output[outputPos++] = temp[o];
            }
            if(preserveAlpha) {
                output[outputPos++] = input[inputPos++];
            } else {
                if(inputHasAlpha)  { inputPos++;  }
                if(outputHasAlpha) {
                    output[outputPos++] = 255;
                }
            }
        }
    };

    /**
     * HOT PATH. 3D LUT, 3-channel input → N-channel output (N != 3 and N != 4).
     * Typical use: RGB → 5+-channel inks (n-color separations).
     *
     * TODO (B3): Currently delegates to tetrahedralInterp3D_NCh per pixel and
     * allocates per-pixel arrays. Should be inlined like the 3Ch / 4Ch
     * variants for image-grade speed on n-color workflows.
     *
     * See HOT PATH header above tetrahedralInterp3DArray_4Ch_loop.
     */
    tetrahedralInterp3DArray_NCh_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha) {
        var colorIn, temp, o;
        var outputChannels = lut.outputChannels;
        colorIn = new Uint8ClampedArray(3);
        for(var p = 0; p < length; p++) {
            colorIn[0] = input[inputPos++];
            colorIn[1] = input[inputPos++];
            colorIn[2] = input[inputPos++];
            temp = this.tetrahedralInterp3D_NCh(colorIn, lut)
            for(o = 0; o < outputChannels; o++) {
                output[outputPos++] = temp[o];
            }
            if(preserveAlpha) {
                output[outputPos++] = input[inputPos++];
            } else {
                if(inputHasAlpha)  { inputPos++;  }
                if(outputHasAlpha) {
                    output[outputPos++] = 255;
                }
            }
        }
    }

    /**
     * HOT PATH. 4D LUT, 4-channel input → N-channel output (N != 3 and N != 4).
     * Typical use: CMYK → 5+-channel inks (n-color separations).
     *
     * TODO (B3): Currently delegates to tetrahedralInterp4D_NCh per pixel and
     * allocates per-pixel arrays. Should be inlined like the 3Ch / 4Ch
     * variants for image-grade speed on n-color workflows.
     *
     * See HOT PATH header above tetrahedralInterp3DArray_4Ch_loop.
     */
    tetrahedralInterp4DArray_NCh_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha) {
        var colorIn, temp, o;
        var outputChannels = lut.outputChannels;
        colorIn = new Uint8ClampedArray(4);
        for(var p = 0; p < length; p++) {
            colorIn[0] = input[inputPos++];
            colorIn[1] = input[inputPos++];
            colorIn[2] = input[inputPos++];
            colorIn[3] = input[inputPos++];
            temp = this.tetrahedralInterp4D_NCh(colorIn, lut)
            for(o = 0; o < outputChannels; o++) {
                output[outputPos++] = temp[o];
            }
            if(preserveAlpha) {
                output[outputPos++] = input[inputPos++];
            } else {
                if(inputHasAlpha)  { inputPos++;  }
                if(outputHasAlpha) {
                    output[outputPos++] = 255;
                }
            }
        }
    }

    /**
     * HOT PATH. 3D LUT, 3-channel input → 3-channel output.
     * Typical use: RGB → RGB image conversion (e.g. sRGB → AdobeRGB) and
     * RGB → Lab analysis pipelines.
     *
     * The most-exercised inner loop in this file. See HOT PATH header above
     * tetrahedralInterp3DArray_4Ch_loop for the contract and trade-offs.
     */
    tetrahedralInterp3DArray_3Ch_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
        var rx,ry,rz,
            X0,X1,Y0,
            Y1,Z0,Z1,
            px,py,pz,
            input0, input1, input2
        var base1,base2,base3,base4,
            c0,c1,c2, a, b

        var outputScale = lut.outputScale;
        var gridPointsScale = (lut.g1 - 1) * lut.inputScale;
        var CLUT = lut.CLUT;
        var go0 = lut.go0;
        var go1 = lut.go1;
        var go2 = lut.go2;

        for(var p = 0; p < length; p++) {

            // We need some clipping here
            input0 = input[inputPos++];
            input1 = input[inputPos++];
            input2 = input[inputPos++];

            // No clipping checks for speed needed for clamped arrays

            // Rather than divide input by 255 then multiply by (lut.g1 - 1)
            // Just do this once, this means input0 stays an int and
            // only px needs to be a float
            px = input0 * gridPointsScale;
            py = input1 * gridPointsScale;
            pz = input2 * gridPointsScale;

            //
            // A few optimisations here, X0 is multiplied by go2, which is precalculated grid x outputChannels
            // Keeping input0 as int means we can just check input0 === 255 rather than input0 >= 1.0 as a float
            // And rather than X0+1 we can just do X0 + offset to location in lut
            X0 = ~~px; //~~ is the same as Math.floor(px)
            rx = (px - X0); // get the fractional part
            X0 *= go2; // change to index in array
            X1 = (input0 === 255) ? X0 : X0 + go2; // work out next index

            Y0 = ~~py;
            ry = (py - Y0);
            Y0 *= go1;
            Y1 = (input1 === 255) ? Y0 : Y0 + go1;

            Z0 = ~~pz;
            rz = (pz - Z0);
            Z0 *= go0;
            Z1 = (input2 === 255) ? Z0 : Z0 + go0;

            // Starting point in CLUT
            // Note that X0, Y0, Z0 are all multiplied by the grid offset and the outputChannels
            // So we only need additions rather than n = ((X0 * go2) + (Y0 * go1) + Z0)) * outputChannels
            base1 = X0 + Y0 + Z0;
            c0 = CLUT[base1++];
            c1 = CLUT[base1++];
            c2 = CLUT[base1];

            if (rx >= ry && ry >= rz) {
                // block1
                base1 = X1 + Y0 + Z0;
                base2 = X1 + Y1 + Z0;
                //base3 = base1; SAME AS base1
                base4 = X1 + Y1 + Z1;
                //base5 = base2; SAME as base2

                // Important performance issues noted in Chrome and Firefox, assigning intermediate variables slows things down a lot
                // Just having one long line of code is much faster, I suspect internally all this math is done in registers,
                // as the JIT can see that variables are not used, so it can just do the math and store the result
                // If we were to use intermediate variables forces the compiler to read/write memory and potentially trigger the GC
                // However using a/b below to read only once from the array does appear to be faster, The less memory reads the better
                //
                // Note that baseN is increased after each read from the array to move to the next channel
                a = CLUT[base1++];
                b = CLUT[base2++];
                output[outputPos++] = (c0 + ((a - c0) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[outputPos++] = (c1 + ((a - c1) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

                a = CLUT[base1];
                b = CLUT[base2];
                output[outputPos++] = (c2 + ((a - c2) * rx) +  ((b - a) * ry) + ((CLUT[base4] - b) * rz)) * outputScale;


            } else if (rx >= rz && rz >= ry) {
                // block2

                base1 = X1 + Y0 + Z0;
                base2 = X1 + Y1 + Z1;
                base3 = X1 + Y0 + Z1;
                //base4 = base3;
                //base5 = base1;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[outputPos++] =( c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[outputPos++] =( c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base3];
                b = CLUT[base1];
                output[outputPos++] =( c2 + ((b - c2) * rx) + ((CLUT[base2] - a) * ry) + ((a - b) * rz) ) * outputScale;



            } else if (rx >= ry && rz >= rx) {
                // block3

                base1 = X1 + Y0 + Z1;
                base2 = X0 + Y0 + Z1;
                base3 = X1 + Y1 + Z1;
                //base4 = base1;
                //base5 = base2;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[outputPos++] = (c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[outputPos++] = (c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz)) * outputScale;

                a = CLUT[base1];
                b = CLUT[base2];
                output[outputPos++] = (c2 + ((a - b) * rx) + ((CLUT[base3] - a) * ry) + ((b - c2) * rz)) * outputScale;



            } else if (ry >= rx && rx >= rz) {
                // block4

                base1 = X1 + Y1 + Z0;
                base2 = X0 + Y1 + Z0;
                //base3 = base2;
                base4 = X1 + Y1 + Z1;
                //base5 = base1;

                a = CLUT[base2++];
                b = CLUT[base1++];
                output[outputPos++] = (c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base1++];
                output[outputPos++] = (c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

                a = CLUT[base2];
                b = CLUT[base1];
                output[outputPos++] = (c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4] - b) * rz) ) * outputScale;


            } else if (ry >= rz && rz >= rx) {
                // block5

                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                base3 = X0 + Y1 + Z0;
                //base4 = base2;
                //base5 = base3;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[outputPos++] = (c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[outputPos++] = (c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base2];
                b = CLUT[base3];
                output[outputPos++] = (c2 + ((CLUT[base1] - a) * rx) + ((b - c2) * ry) + ((a - b) * rz) ) * outputScale;


            } else if (rz >= ry && ry >= rx) {
                // block6

                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                //base3 = base2;
                base4 = X0 + Y0 + Z1;
                //base5 = base4;

                a = CLUT[base2++]
                b = CLUT[base4++]
                output[outputPos++] = (c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz) ) * outputScale;

                a = CLUT[base2++]
                b = CLUT[base4++]
                output[outputPos++] = (c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz) ) * outputScale;

                a = CLUT[base2]
                b = CLUT[base4]
                output[outputPos++] = (c2 + ((CLUT[base1] - a) * rx) + ((a - b) * ry) + ((b - c2) * rz) ) * outputScale;

            } else {
                output[outputPos++] = c0 * outputScale;
                output[outputPos++] = c1 * outputScale;
                output[outputPos++] = c2 * outputScale;
            }

            // Alpha handling — MUST be inside the per-pixel loop. Was previously
            // outside the for, which silently broke alpha preservation for any
            // RGB->RGB / RGB->Lab LUT image transform with more than one pixel
            // (e.g. soft-proof chains). See bug fix in CHANGELOG.
            if(preserveAlpha) {
                output[outputPos++] = input[inputPos++];
            } else {
                if(inputHasAlpha)  { inputPos++;  }
                if(outputHasAlpha) {
                    output[outputPos++] = 255;
                }
            }
        }
    };

    /* ====================================================================
     * INTEGER HOT PATH KERNELS — lutMode='int' (opt-in)
     * --------------------------------------------------------------------
     * One-to-one with their float siblings above; opted into via the
     * `lutMode: 'int'` constructor option. Each variant assumes:
     *
     *   - intLut.CLUT is Uint16Array, values in [0, 65280] (= 255*256,
     *     NOT 65535 — see buildIntLut JSDoc for why; in short, the
     *     kernel's final >> 8 divides by 256 exactly, so scaling the
     *     CLUT by 256*255 makes u16/256 = u8 with no systematic bias)
     *   - intLut.gridPointsScale_fixed is Q0.16 (e.g. 8224 for g1=33,
     *     NOT 32 — the Q0.8 version truncated (g1-1)/255 enough to
     *     introduce a second int>float bias on decreasing axes)
     *   - intLut.maxX/Y/Z[/maxK] hold (g1-1)*goN for the input===255
     *     boundary patch (see bench/int_vs_float.js FINDING #2 —
     *     non-optional, fixes a corner-rounding bug)
     *   - input is u8 (Uint8ClampedArray), values 0..255
     *   - output is u8 (Uint8ClampedArray); the array's natural clamp
     *     handles any ±1 LSB rounding overshoot at corners
     *
     * Math contract:
     *   Q0.16 input scale: px = Math.imul(input, gps) is a Q8.16 value.
     *   Extract: X0 = px >>> 16, rx = (px >>> 8) & 0xFF (Q0.8).
     *
     *   Q0.8 weights (rx/ry/rz/rk in [0..255]). Per-channel:
     *     u16_out = c0 + ((sum_in_Q0.8 + 0x80) >> 8)   // round-to-nearest
     *     u8_out  = (u16_out + 0x80) >> 8
     *
     * For 4D kernels the K-axis adds one more interp pass. 4D uses a
     * u20 (Q16.4) single-rounding intermediate to avoid stacked-round
     * error — see tetrahedralInterp4DArray_3Ch_intLut_loop JSDoc.
     *
     * Result: ~1.05–1.20× in-engine speedup vs float kernel, max diff
     * **≤ 1 LSB on u8 output across all four directions** (0 LSB on
     * RGB→RGB). The residual 1 LSB is Uint8ClampedArray banker's
     * rounding disagreeing with the kernel's round-half-up at exact
     * X.5 half-ties — not interpolation error. See
     * bench/fastLUT_real_world.js (3D+4D real numbers) and
     * bench/diag_cmyk_to_rgb.js (accuracy trail for the two fixes
     * that eliminated the systematic +0.4 % bias and the Q0.8 gps
     * truncation bias).
     *
     * ⚠ DO NOT EDIT WITHOUT RUNNING THE BENCH. The hot paths are
     *   tightly tuned for V8 (Math.imul + bit shifts + monomorphic
     *   call sites) — innocent-looking changes (e.g. extracting
     *   sub-expressions to temp vars) routinely lose 10-30% perf.
     * ==================================================================== */

    /**
     * INT HOT PATH. 3D LUT, 3-channel input → 3-channel output.
     * Integer-math sibling of tetrahedralInterp3DArray_3Ch_loop.
     * Used when lutMode='int' is set. See INTEGER HOT PATH header above.
     */
    tetrahedralInterp3DArray_3Ch_intLut_loop(input, inputPos, output, outputPos, length, intLut, inputHasAlpha, outputHasAlpha, preserveAlpha){
        var rx = 0|0, ry = 0|0, rz = 0|0;
        var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0;
        var px = 0|0, py = 0|0, pz = 0|0;
        var input0 = 0|0, input1 = 0|0, input2 = 0|0;
        var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
        var c0 = 0|0, c1 = 0|0, c2 = 0|0, a = 0|0, b = 0|0;

        var gps  = intLut.gridPointsScale_fixed | 0;
        var CLUT = intLut.CLUT;
        var go0  = intLut.go0 | 0;
        var go1  = intLut.go1 | 0;
        var go2  = intLut.go2 | 0;
        var maxX = intLut.maxX | 0;
        var maxY = intLut.maxY | 0;
        var maxZ = intLut.maxZ | 0;

        for(var p = 0; p < length; p++) {
            input0 = input[inputPos++];
            input1 = input[inputPos++];
            input2 = input[inputPos++];

            px = Math.imul(input0, gps);
            py = Math.imul(input1, gps);
            pz = Math.imul(input2, gps);

            // Per-axis input===255 boundary patch (FINDING #2 in bench).
            if (input0 === 255) { X0 = maxX; X1 = maxX; rx = 0; }
            else { X0 = px >>> 16; rx = (px >>> 8) & 0xFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

            if (input1 === 255) { Y0 = maxY; Y1 = maxY; ry = 0; }
            else { Y0 = py >>> 16; ry = (py >>> 8) & 0xFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

            if (input2 === 255) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
            else { Z0 = pz >>> 16; rz = (pz >>> 8) & 0xFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

            base1 = X0 + Y0 + Z0;
            c0 = CLUT[base1++];
            c1 = CLUT[base1++];
            c2 = CLUT[base1];

            if (rx >= ry && ry >= rz) {
                base1 = X1 + Y0 + Z0;
                base2 = X1 + Y1 + Z0;
                base4 = X1 + Y1 + Z1;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = ((c0 + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = ((c1 + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base1];   b = CLUT[base2];
                output[outputPos++] = ((c2 + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            } else if (rx >= rz && rz >= ry) {
                base1 = X1 + Y0 + Z0;
                base2 = X1 + Y1 + Z1;
                base3 = X1 + Y0 + Z1;
                a = CLUT[base3++]; b = CLUT[base1++];
                output[outputPos++] = ((c0 + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base3++]; b = CLUT[base1++];
                output[outputPos++] = ((c1 + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base3];   b = CLUT[base1];
                output[outputPos++] = ((c2 + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            } else if (rx >= ry && rz >= rx) {
                base1 = X1 + Y0 + Z1;
                base2 = X0 + Y0 + Z1;
                base3 = X1 + Y1 + Z1;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = ((c0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = ((c1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base1];   b = CLUT[base2];
                output[outputPos++] = ((c2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c2, rz) + 0x80) >> 8)) + 0x80) >> 8;
            } else if (ry >= rx && rx >= rz) {
                base1 = X1 + Y1 + Z0;
                base2 = X0 + Y1 + Z0;
                base4 = X1 + Y1 + Z1;
                a = CLUT[base2++]; b = CLUT[base1++];
                output[outputPos++] = ((c0 + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base2++]; b = CLUT[base1++];
                output[outputPos++] = ((c1 + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base2];   b = CLUT[base1];
                output[outputPos++] = ((c2 + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            } else if (ry >= rz && rz >= rx) {
                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                base3 = X0 + Y1 + Z0;
                a = CLUT[base2++]; b = CLUT[base3++];
                output[outputPos++] = ((c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base2++]; b = CLUT[base3++];
                output[outputPos++] = ((c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base2];   b = CLUT[base3];
                output[outputPos++] = ((c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            } else if (rz >= ry && ry >= rx) {
                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                base4 = X0 + Y0 + Z1;
                a = CLUT[base2++]; b = CLUT[base4++];
                output[outputPos++] = ((c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base2++]; b = CLUT[base4++];
                output[outputPos++] = ((c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x80) >> 8)) + 0x80) >> 8;
                a = CLUT[base2];   b = CLUT[base4];
                output[outputPos++] = ((c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x80) >> 8)) + 0x80) >> 8;
            } else {
                output[outputPos++] = (c0 + 0x80) >> 8;
                output[outputPos++] = (c1 + 0x80) >> 8;
                output[outputPos++] = (c2 + 0x80) >> 8;
            }

            // Alpha handling — same shape as the float sibling above.
            if(preserveAlpha) {
                output[outputPos++] = input[inputPos++];
            } else {
                if(inputHasAlpha)  { inputPos++;  }
                if(outputHasAlpha) {
                    output[outputPos++] = 255;
                }
            }
        }
    };

    /**
     * HOT PATH. 4D LUT, 4-channel input → 3-channel output.
     * Typical use: CMYK → RGB image conversion (preview / soft-proof) and
     * CMYK → Lab analysis pipelines.
     *
     * Includes the K-axis interpolation as a second pass (interpK flag): when
     * the K fraction is zero, the function skips the second tetrahedron and
     * returns the 3D result directly — meaningful speed-up on flat K regions.
     *
     * See HOT PATH header above tetrahedralInterp3DArray_4Ch_loop.
     */
    tetrahedralInterp4DArray_3Ch_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
        var X0, X1, Y0, K0,
            Y1, Z0, Z1,
            rx, ry, rz, rk,
            px, py, pz, pk,
            input0, input1, input2, inputK,
            base1, base2, base3, base4,
            c0, c1, c2,
            o0, o1, o2,
            d0, d1, d2,
            a, b,
            interpK;

        var outputScale = lut.outputScale;
        var gridPointsScale = (lut.g1 - 1) * lut.inputScale;
        var CLUT = lut.CLUT;
        var go0 = lut.go0;
        var go1 = lut.go1;
        var go2 = lut.go2;
        var go3 = lut.go3;
        var kOffset = go3 - lut.outputChannels + 1; // +1 since we don't do a [base++] for the last CLUT lookup

        for(var p = 0; p < length; p++) {

            // We need some clipping here
            inputK = input[inputPos++]; // K
            input0 = input[inputPos++]; // C
            input1 = input[inputPos++]; // M
            input2 = input[inputPos++]; // Y


            // No clipping checks for speed needed for clamped arrays

            px = input0 * gridPointsScale;
            py = input1 * gridPointsScale;
            pz = input2 * gridPointsScale;
            pk = inputK * gridPointsScale;

            K0 = ~~pk;
            rk = (pk - K0);
            K0 *= go3;
            // K1 is not required, we just need to test if
            // we need to interpolate or not

            X0 = ~~px; //~~ is the same as Math.floor(px)
            rx = (px - X0); // get the fractional part
            X0 *= go2; // change to index in array
            X1 = (input0 === 255) ? X0 : X0 + go2; // work out next index

            Y0 = ~~py;
            ry = (py - Y0);
            Y0 *= go1;
            Y1 = (input1 === 255) ? Y0 : Y0 + go1;

            Z0 = ~~pz;
            rz = (pz - Z0);
            Z0 *= go0;
            Z1 = (input2 === 255) ? Z0 : Z0 + go0;

            base1 = X0 + Y0 + Z0 + K0;
            c0 = CLUT[base1++];
            c1 = CLUT[base1++];
            c2 = CLUT[base1];

            if(inputK === 255 || rk === 0) {
                interpK = false;
            } else {
                base1 +=kOffset;
                d0 = CLUT[base1++];
                d1 = CLUT[base1++];
                d2 = CLUT[base1];
                interpK = true;
            }

            if (rx >= ry && ry >= rz) {
                // block1
                base1 = X1 + Y0 + Z0 + K0;
                base2 = X1 + Y1 + Z0 + K0;
                //base3 = base1; SAME AS base1
                base4 = X1 + Y1 + Z1 + K0;
                //base5 = base2; SAME as base2

                // Note that baseN is increased after each read from the array to move to the next channel
                a = CLUT[base1++];
                b = CLUT[base2++];
                o0 = (c0 + ((a - c0) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz));

                a = CLUT[base1++];
                b = CLUT[base2++];
                o1 = (c1 + ((a - c1) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz));

                a = CLUT[base1];
                b = CLUT[base2];
                o2 = (c2 + ((a - c2) * rx) +  ((b - a) * ry) + ((CLUT[base4] - b) * rz));

                if(interpK) {
                    base1+=kOffset;
                    base2+=kOffset;
                    base4+=kOffset;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    //output[outputPos++] = c1 + (( d1 - c1 ) * rk)
                    output[outputPos++] = (o0 + (((d0 + ((a - d0) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o0) * rk)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (o1 + (((d1 + ((a - d1) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o1) * rk)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (o2 + (((d2 + ((a - d2) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o2) * rk)) * outputScale;

                } else {
                    output[outputPos++] = o0 * outputScale;
                    output[outputPos++] = o1 * outputScale;
                    output[outputPos++] = o2 * outputScale;
                }

            } else if (rx >= rz && rz >= ry) {
                // block2

                base1 = X1 + Y0 + Z0 + K0;
                base2 = X1 + Y1 + Z1 + K0;
                base3 = X1 + Y0 + Z1 + K0;
                //base4 = base3;
                //base5 = base1;

                a = CLUT[base3++];
                b = CLUT[base1++];
                o0 = c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);

                a = CLUT[base3++];
                b = CLUT[base1++];
                o1 = c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);

                a = CLUT[base3];
                b = CLUT[base1];
                o2 = c2 + ((b - c2) * rx) + ((CLUT[base2] - a) * ry) + ((a - b) * rz);


                if(interpK) {
                    base3 += kOffset;
                    base1 += kOffset;
                    base2 += kOffset;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[outputPos++] = (o0 + ((( d0 + ((b - d0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[outputPos++] = (o1 + ((( d1 + ((b - d1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[outputPos++] = (o2 + ((( d2 + ((b - d2) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

                } else {
                    output[outputPos++] = o0 * outputScale;
                    output[outputPos++] = o1 * outputScale;
                    output[outputPos++] = o2 * outputScale;
                }

            } else if (rx >= ry && rz >= rx) {
                // block3

                base1 = X1 + Y0 + Z1 + K0;
                base2 = X0 + Y0 + Z1 + K0;
                base3 = X1 + Y1 + Z1 + K0;
                //base4 = base1;
                //base5 = base2;

                a = CLUT[base1++];
                b = CLUT[base2++];
                o0 = c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz);

                a = CLUT[base1++];
                b = CLUT[base2++];
                o1 = c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz);

                a = CLUT[base1];
                b = CLUT[base2];
                o2 = c2 + ((a - b) * rx) + ((CLUT[base3] - a) * ry) + ((b - c2) * rz);


                if(interpK) {
                    base1 += kOffset;
                    base2 += kOffset;
                    base3 += kOffset;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (o0 + ((( d0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - d0) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (o1 + ((( d1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - d1) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (o2 + ((( d2 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - d2) * rz) ) - o2) * rk)) * outputScale;
                } else {
                    output[outputPos++] = o0 * outputScale;
                    output[outputPos++] = o1 * outputScale;
                    output[outputPos++] = o2 * outputScale;
                }

            } else if (ry >= rx && rx >= rz) {
                // block4

                base1 = X1 + Y1 + Z0 + K0;
                base2 = X0 + Y1 + Z0 + K0;
                //base3 = base2;
                base4 = X1 + Y1 + Z1 + K0;
                //base5 = base1;

                a = CLUT[base2++];
                b = CLUT[base1++];
                o0 = c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz);

                a = CLUT[base2++];
                b = CLUT[base1++];
                o1 = c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz);

                a = CLUT[base2];
                b = CLUT[base1];
                o2 = c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4] - b) * rz);


                if(interpK) {
                    base1 += kOffset;
                    base2 += kOffset;
                    base4 += kOffset;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    output[outputPos++] = (o0 + ((( d0 + ((b - a) * rx) + ((a - d0) * ry) + ((CLUT[base4++] - b) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    output[outputPos++] = (o1 + ((( d1 + ((b - a) * rx) + ((a - d1) * ry) + ((CLUT[base4++] - b) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    output[outputPos++] = (o2 + ((( d2 + ((b - a) * rx) + ((a - d2) * ry) + ((CLUT[base4++] - b) * rz) ) - o2) * rk)) * outputScale;

                } else {
                    output[outputPos++] = o0 * outputScale;
                    output[outputPos++] = o1 * outputScale;
                    output[outputPos++] = o2 * outputScale;
                }

            } else if (ry >= rz && rz >= rx) {
                // block5

                base1 = X1 + Y1 + Z1 + K0;
                base2 = X0 + Y1 + Z1 + K0;
                base3 = X0 + Y1 + Z0 + K0;
                //base4 = base2;
                //base5 = base3;

                a = CLUT[base2++];
                b = CLUT[base3++];
                o0 = c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz);

                a = CLUT[base2++];
                b = CLUT[base3++];
                o1 = c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz);

                a = CLUT[base2];
                b = CLUT[base3];
                o2 = c2 + ((CLUT[base1] - a) * rx) + ((b - c2) * ry) + ((a - b) * rz);

                if(interpK) {
                    base1 += kOffset;
                    base2 += kOffset;
                    base3 += kOffset;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    output[outputPos++] = (o0 + ((( d0 + ((CLUT[base1++] - a) * rx) + ((b - d0) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    output[outputPos++] = (o1 + ((( d1 + ((CLUT[base1++] - a) * rx) + ((b - d1) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    output[outputPos++] = (o2 + ((( d2 + ((CLUT[base1++] - a) * rx) + ((b - d2) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

                } else {
                    output[outputPos++] = o0 * outputScale;
                    output[outputPos++] = o1 * outputScale;
                    output[outputPos++] = o2 * outputScale;
                }

            } else if (rz >= ry && ry >= rx) {
                // block6

                base1 = X1 + Y1 + Z1 + K0;
                base2 = X0 + Y1 + Z1 + K0;
                //base3 = base2;
                base4 = X0 + Y0 + Z1 + K0;
                //base5 = base4;

                a = CLUT[base2++]
                b = CLUT[base4++]
                o0 = c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz) ;

                a = CLUT[base2++]
                b = CLUT[base4++]
                o1 = c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz);

                a = CLUT[base2]
                b = CLUT[base4]
                o2 = c2 + ((CLUT[base1] - a) * rx) + ((a - b) * ry) + ((b - c2) * rz);

                if(interpK) {
                    base1 += kOffset;
                    base2 += kOffset;
                    base4 += kOffset;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    output[outputPos++] = (o0 + ((( d0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - d0) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    output[outputPos++] = (o1 + ((( d1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - d1) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    output[outputPos++] = (o2 + ((( d2 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - d2) * rz) ) - o2) * rk)) * outputScale;

                } else {
                    output[outputPos++] = o0 * outputScale;
                    output[outputPos++] = o1 * outputScale;
                    output[outputPos++] = o2 * outputScale;
                }

            } else {
                if(interpK) {
                    output[outputPos++] = c0 + (( d0 - c0 ) * rk) * outputScale;
                    output[outputPos++] = c1 + (( d1 - c1 ) * rk) * outputScale;
                    output[outputPos++] = c2 + (( d2 - c2 ) * rk) * outputScale;
                } else {
                    output[outputPos++] = c0 * outputScale;
                    output[outputPos++] = c1 * outputScale;
                    output[outputPos++] = c2 * outputScale;
                }
            }

            if(preserveAlpha) {
                output[outputPos++] = input[inputPos++];
            } else {
                if(inputHasAlpha)  { inputPos++;  }
                if(outputHasAlpha) {
                    output[outputPos++] = 255;
                }
            }
        }
    };

    /**
     * HOT PATH. 4D LUT, 4-channel input → 4-channel output.
     * Typical use: CMYK → CMYK image conversion (e.g. SWOP → GRACoL,
     * profile-to-profile re-purposing for press changes).
     *
     * As with the 3Ch 4D variant, the K axis is interpolated as a second
     * pass with an early-out (interpK flag) when rk is zero.
     *
     * See HOT PATH header above tetrahedralInterp3DArray_4Ch_loop.
     */
    tetrahedralInterp4DArray_4Ch_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
        var X0, X1, Y0, K0,
            Y1, Z0, Z1,
            rx, ry, rz, rk,
            px, py, pz, pk,
            input0, input1, input2, inputK,
            base1, base2, base3, base4,
            c0, c1, c2, c3,
            o0, o1, o2, o3,
            k0, k1, k2, k3,
            a, b,
            interpK;

        var outputScale = lut.outputScale;
        var gridPointsScale = (lut.g1 - 1) * lut.inputScale;
        var CLUT = lut.CLUT;
        var go0 = lut.go0;
        var go1 = lut.go1;
        var go2 = lut.go2;
        var go3 = lut.go3;
        var kOffset = go3 - lut.outputChannels + 1; // +1 since we don't do a [base++] for the last CLUT lookup

        for(var p = 0; p < length; p++) {

            // We need some clipping here
            inputK = input[inputPos++]; // K
            input0 = input[inputPos++]; // C
            input1 = input[inputPos++]; // M
            input2 = input[inputPos++]; // Y

            // No clipping checks for speed needed for clamped arrays
            px = input0 * gridPointsScale;
            py = input1 * gridPointsScale;
            pz = input2 * gridPointsScale;
            pk = inputK * gridPointsScale;

            K0 = ~~pk;
            rk = (pk - K0);
            K0 *= go3;
            // K1 is not required, we just need to test if
            // we need to interpolate or not

            X0 = ~~px; //~~ is the same as Math.floor(px)
            rx = (px - X0); // get the fractional part
            X0 *= go2; // change to index in array
            X1 = (input0 === 255) ? X0 : X0 + go2; // work out next index

            Y0 = ~~py;
            ry = (py - Y0);
            Y0 *= go1;
            Y1 = (input1 === 255) ? Y0 : Y0 + go1;

            Z0 = ~~pz;
            rz = (pz - Z0);
            Z0 *= go0;
            Z1 = (input2 === 255) ? Z0 : Z0 + go0;

            base1 = X0 + Y0 + Z0 + K0;

            base1 = X0 + Y0 + Z0 + K0;
            c0 = CLUT[base1++];
            c1 = CLUT[base1++];
            c2 = CLUT[base1++];
            c3 = CLUT[base1];

            if(inputK === 255 || rk === 0) {
                interpK = false;
            } else {
                base1 +=kOffset;
                k0 = CLUT[base1++];
                k1 = CLUT[base1++];
                k2 = CLUT[base1++];
                k3 = CLUT[base1];
                interpK = true;
            }

            if (rx >= ry && ry >= rz) {
                // block1
                base1 = X1 + Y0 + Z0 + K0;
                base2 = X1 + Y1 + Z0 + K0;
                //base3 = base1; SAME AS base1
                base4 = X1 + Y1 + Z1 + K0;
                //base5 = base2; SAME as base2

                // Note that baseN is increased after each read from the array to move to the next channel
                a = CLUT[base1++];
                b = CLUT[base2++];
                o0 = (c0 + ((a - c0) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz));

                a = CLUT[base1++];
                b = CLUT[base2++];
                o1 = (c1 + ((a - c1) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz));

                a = CLUT[base1++];
                b = CLUT[base2++];
                o2 = (c2 + ((a - c2) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz));

                a = CLUT[base1];
                b = CLUT[base2];
                o3 = (c3 + ((a - c3) * rx) +  ((b - a) * ry) + ((CLUT[base4] - b) * rz));

                if(interpK) {
                    base1+=kOffset;
                    base2+=kOffset;
                    base4+=kOffset;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    //output[outputPos++] = c1 + (( d1 - c1 ) * rk)
                    output[outputPos++] = (o0 + (((k0 + ((a - k0) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o0) * rk)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (o1 + (((k1 + ((a - k1) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o1) * rk)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (o2 + (((k2 + ((a - k2) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o2) * rk)) * outputScale;

                    a = CLUT[base1];
                    b = CLUT[base2];
                    output[outputPos++] = (o3 + (((k3 + ((a - k3) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o3) * rk)) * outputScale;
                } else {
                    output[outputPos++] = o0 * outputScale;
                    output[outputPos++] = o1 * outputScale;
                    output[outputPos++] = o2 * outputScale;
                    output[outputPos++] = o3 * outputScale;
                }

            } else if (rx >= rz && rz >= ry) {
                // block2

                base1 = X1 + Y0 + Z0 + K0;
                base2 = X1 + Y1 + Z1 + K0;
                base3 = X1 + Y0 + Z1 + K0;
                //base4 = base3;
                //base5 = base1;

                a = CLUT[base3++];
                b = CLUT[base1++];
                o0 = c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);

                a = CLUT[base3++];
                b = CLUT[base1++];
                o1 = c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);

                a = CLUT[base3++];
                b = CLUT[base1++];
                o2 = c2 + ((b - c2) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);

                a = CLUT[base3];
                b = CLUT[base1];
                o3 = c3 + ((b - c3) * rx) + ((CLUT[base2] - a) * ry) + ((a - b) * rz);

                if(interpK) {
                    base3 += kOffset;
                    base1 += kOffset;
                    base2 += kOffset;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[outputPos++] = (o0 + ((( k0 + ((b - k0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[outputPos++] = (o1 + ((( k1 + ((b - k1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[outputPos++] = (o2 + ((( k2 + ((b - k2) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[outputPos++] = (o3 + ((( k3 + ((b - k3) * rx) + ((CLUT[base2  ] - a) * ry) + ((a - b) * rz) ) - o3) * rk)) * outputScale;
                } else {
                    output[outputPos++] = o0 * outputScale;
                    output[outputPos++] = o1 * outputScale;
                    output[outputPos++] = o2 * outputScale;
                    output[outputPos++] = o3 * outputScale;
                }

            } else if (rx >= ry && rz >= rx) {
                // block3

                base1 = X1 + Y0 + Z1 + K0;
                base2 = X0 + Y0 + Z1 + K0;
                base3 = X1 + Y1 + Z1 + K0;
                //base4 = base1;
                //base5 = base2;

                a = CLUT[base1++];
                b = CLUT[base2++];
                o0 = c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz);

                a = CLUT[base1++];
                b = CLUT[base2++];
                o1 = c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz);

                a = CLUT[base1++];
                b = CLUT[base2++];
                o2 = c2 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c2) * rz);

                a = CLUT[base1];
                b = CLUT[base2];
                o3 = c3 + ((a - b) * rx) + ((CLUT[base3] - a) * ry) + ((b - c3) * rz);

                if(interpK) {
                    base1 += kOffset;
                    base2 += kOffset;
                    base3 += kOffset;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (o0 + ((( k0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - k0) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (o1 + ((( k1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - k1) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (o2 + ((( k2 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - k2) * rz) ) - o2) * rk)) * outputScale;

                    a = CLUT[base1];
                    b = CLUT[base2];
                    output[outputPos++] = (o3 + ((( k3 + ((a - b) * rx) + ((CLUT[base3  ] - a) * ry) + ((b - k3) * rz) ) - o3) * rk)) * outputScale;
                } else {
                    output[outputPos++] = o0 * outputScale;
                    output[outputPos++] = o1 * outputScale;
                    output[outputPos++] = o2 * outputScale;
                    output[outputPos++] = o3 * outputScale;
                }

            } else if (ry >= rx && rx >= rz) {
                // block4

                base1 = X1 + Y1 + Z0 + K0;
                base2 = X0 + Y1 + Z0 + K0;
                //base3 = base2;
                base4 = X1 + Y1 + Z1 + K0;
                //base5 = base1;

                a = CLUT[base2++];
                b = CLUT[base1++];
                o0 = c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz);

                a = CLUT[base2++];
                b = CLUT[base1++];
                o1 = c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz);

                a = CLUT[base2++];
                b = CLUT[base1++];
                o2 = c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4++] - b) * rz);

                a = CLUT[base2];
                b = CLUT[base1];
                o3 = c3 + ((b - a) * rx) + ((a - c3) * ry) + ((CLUT[base4] - b) * rz);

                if(interpK) {
                    base1 += kOffset;
                    base2 += kOffset;
                    base4 += kOffset;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    output[outputPos++] = (o0 + ((( k0 + ((b - a) * rx) + ((a - k0) * ry) + ((CLUT[base4++] - b) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    output[outputPos++] = (o1 + ((( k1 + ((b - a) * rx) + ((a - k1) * ry) + ((CLUT[base4++] - b) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    output[outputPos++] = (o2 + ((( k2 + ((b - a) * rx) + ((a - k2) * ry) + ((CLUT[base4++] - b) * rz) ) - o2) * rk)) * outputScale;

                    a = CLUT[base2];
                    b = CLUT[base1];
                    output[outputPos++] = (o3 + ((( k3 + ((b - a) * rx) + ((a - k3) * ry) + ((CLUT[base4  ] - b) * rz) ) - o3) * rk)) * outputScale;
                } else {
                    output[outputPos++] = o0 * outputScale;
                    output[outputPos++] = o1 * outputScale;
                    output[outputPos++] = o2 * outputScale;
                    output[outputPos++] = o3 * outputScale;
                }

            } else if (ry >= rz && rz >= rx) {
                // block5

                base1 = X1 + Y1 + Z1 + K0;
                base2 = X0 + Y1 + Z1 + K0;
                base3 = X0 + Y1 + Z0 + K0;
                //base4 = base2;
                //base5 = base3;

                a = CLUT[base2++];
                b = CLUT[base3++];
                o0 = c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz);

                a = CLUT[base2++];
                b = CLUT[base3++];
                o1 = c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz);

                a = CLUT[base2++];
                b = CLUT[base3++];
                o2 = c2 + ((CLUT[base1++] - a) * rx) + ((b - c2) * ry) + ((a - b) * rz);

                a = CLUT[base2];
                b = CLUT[base3];
                o3 = c3 + ((CLUT[base1] - a) * rx) + ((b - c3) * ry) + ((a - b) * rz);

                if(interpK) {
                    base1 += kOffset;
                    base2 += kOffset;
                    base3 += kOffset;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    output[outputPos++] = (o0 + ((( k0 + ((CLUT[base1++] - a) * rx) + ((b - k0) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    output[outputPos++] = (o1 + ((( k1 + ((CLUT[base1++] - a) * rx) + ((b - k1) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    output[outputPos++] = (o2 + ((( k2 + ((CLUT[base1++] - a) * rx) + ((b - k2) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

                    a = CLUT[base2];
                    b = CLUT[base3];
                    output[outputPos++] = (o3 + ((( k3 + ((CLUT[base1++] - a) * rx) + ((b - k3) * ry) + ((a - b) * rz) ) - o3) * rk)) * outputScale;
                } else {
                    output[outputPos++] = o0 * outputScale;
                    output[outputPos++] = o1 * outputScale;
                    output[outputPos++] = o2 * outputScale;
                    output[outputPos++] = o3 * outputScale;
                }

            } else if (rz >= ry && ry >= rx) {
                // block6

                base1 = X1 + Y1 + Z1 + K0;
                base2 = X0 + Y1 + Z1 + K0;
                //base3 = base2;
                base4 = X0 + Y0 + Z1 + K0;
                //base5 = base4;

                a = CLUT[base2++]
                b = CLUT[base4++]
                o0 = c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz) ;

                a = CLUT[base2++]
                b = CLUT[base4++]
                o1 = c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz);

                a = CLUT[base2++]
                b = CLUT[base4++]
                o2 = c2 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c2) * rz);

                a = CLUT[base2]
                b = CLUT[base4]
                o3 = c3 + ((CLUT[base1] - a) * rx) + ((a - b) * ry) + ((b - c3) * rz);

                if(interpK) {
                    base1 += kOffset;
                    base2 += kOffset;
                    base4 += kOffset;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    output[outputPos++] = (o0 + ((( k0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - k0) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    output[outputPos++] = (o1 + ((( k1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - k1) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    output[outputPos++] = (o2 + ((( k2 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - k2) * rz) ) - o2) * rk)) * outputScale;

                    a = CLUT[base2]
                    b = CLUT[base4]
                    output[outputPos++] = (o3 + ((( k3 + ((CLUT[base1  ] - a) * rx) + ((a - b) * ry) + ((b - k3) * rz) ) - o3) * rk)) * outputScale;
                } else {
                    output[outputPos++] = o0 * outputScale;
                    output[outputPos++] = o1 * outputScale;
                    output[outputPos++] = o2 * outputScale;
                    output[outputPos++] = o3 * outputScale;
                }

            } else {
                if(interpK) {
                    output[outputPos++] = c0 + (( k0 - c0 ) * rk) * outputScale;
                    output[outputPos++] = c1 + (( k1 - c1 ) * rk) * outputScale;
                    output[outputPos++] = c2 + (( k2 - c2 ) * rk) * outputScale;
                    output[outputPos++] = c3 + (( k3 - c3 ) * rk) * outputScale;
                } else {
                    output[outputPos++] = c0 * outputScale;
                    output[outputPos++] = c1 * outputScale;
                    output[outputPos++] = c2 * outputScale;
                    output[outputPos++] = c3 * outputScale;
                }
            }

            if(preserveAlpha) {
                output[outputPos++] = input[inputPos++];
            } else {
                if(inputHasAlpha)  { inputPos++;  }
                if(outputHasAlpha) {
                    output[outputPos++] = 255;
                }
            }
        }
    };

    /**
     * INT HOT PATH. 4D LUT, 4-channel input → 3-channel output.
     * Integer-math sibling of tetrahedralInterp4DArray_3Ch_loop.
     * Used when lutMode='int' is set. Typical use: CMYK → RGB / Lab.
     *
     * Same K-axis early-out as the float kernel: when rk=0 (input lands
     * exactly on a K grid plane) or inputK===255 (top boundary), only
     * one 3D tetrahedral pass runs. Otherwise both K planes are
     * interpolated and LERPed by rk.
     *
     * -----------------------------------------------------------------
     * U20 SINGLE-ROUNDING DESIGN (all non-degenerate tetrahedral cases)
     * -----------------------------------------------------------------
     * CLUT stays u16 (Uint16Array). Intermediate interpolated values
     * o0/o1/o2 are carried at u20 precision (Q16.4 — four extra
     * fractional bits vs u16). This buys two things:
     *
     *   1. ONE meaningful rounding step instead of three.
     *      Old kernel did: K0 plane >>8, K1 plane >>8, K-LERP >>8,
     *      final >>8 — four stacked roundings, each ±0.5 LSB of error.
     *      New kernel does: inner >>4 (negligible: 1/16 LSB of u16 =
     *      ~1/4096 LSB of u8), final >>20 (the only meaningful ½ LSB).
     *      Result: max diff on CMYK→CMYK drops from 3 LSB → 1 LSB.
     *      Combined with the u16 CLUT scale fix (255×256 not 65535)
     *      and the Q0.16 `gridPointsScale_fixed` fix (both in v1.1),
     *      CMYK→RGB also holds to ≤1 LSB max on GRACoL2006.
     *
     *   2. No int32 overflow. All intermediate Math.imul operations
     *      fit safely in signed 32-bit. Constraint math:
     *        o0_u20     ≤ 2^20         (u16 × 16)
     *        o0 << 8    ≤ 2^28         (~268M)
     *        |K1-o0|    ≤ 2^20
     *        imul(K1-o0, rk)  ≤ 2^20 × 255  ≤ 2^28
     *        sum        ≤ 2 × 2^28     ≤ 2^29 (~537M)
     *      All well below signed-int32 ceiling (2^31 - 1 ≈ 2.14B).
     *      Going beyond u20 (e.g. u22) would start pushing limits.
     *
     * Final K-LERP collapses three stacked `>> 8` rounds into:
     *   ((o << 8) + imul(K1_u20 - o, rk) + 0x80000) >> 20
     * where K1_u20 is inlined as `(d << 4) + ((sum + 0x08) >> 4)`
     * (no named temporary — the sum expression is reused in place to
     * avoid forcing the JIT to spill `sum` to stack — see PERFORMANCE
     * LESSONS at the top of this file).
     *
     * Non-interpK path: `(o_u20 + 0x800) >> 12` (shift from u20 → u8).
     *
     * Degenerate rx==ry==rz path: uses a straight u16 K-LERP with
     * correct `+0x8000) >> 16` bias. (The pre-u1.1 code had a
     * rounding-bias bug here — `+0x80` instead of `+0x8000` — fixed
     * at the same time as the u20 refactor.)
     *
     * Bench reference: bench/fastLUT_real_world.js with GRACoL2006.
     */
    tetrahedralInterp4DArray_3Ch_intLut_loop(input, inputPos, output, outputPos, length, intLut, inputHasAlpha, outputHasAlpha, preserveAlpha){
        var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0, K0 = 0|0;
        var rx = 0|0, ry = 0|0, rz = 0|0, rk = 0|0;
        var px = 0|0, py = 0|0, pz = 0|0, pk = 0|0;
        var input0 = 0|0, input1 = 0|0, input2 = 0|0, inputK = 0|0;
        var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
        var c0 = 0|0, c1 = 0|0, c2 = 0|0;
        var d0 = 0|0, d1 = 0|0, d2 = 0|0;
        var o0 = 0|0, o1 = 0|0, o2 = 0|0;
        var a = 0|0, b = 0|0;
        var interpK = false;

        var gps  = intLut.gridPointsScale_fixed | 0;
        var CLUT = intLut.CLUT;
        var go0  = intLut.go0 | 0;
        var go1  = intLut.go1 | 0;
        var go2  = intLut.go2 | 0;
        var go3  = intLut.go3 | 0;
        var maxX = intLut.maxX | 0;
        var maxY = intLut.maxY | 0;
        var maxZ = intLut.maxZ | 0;
        var maxK = intLut.maxK | 0;
        // +1 because the c0/c1/c2 reads above didn't do a final base++ before
        // jumping to the K1 plane — same convention as the float kernel.
        var kOffset = (go3 - intLut.outputChannels + 1) | 0;

        for(var p = 0; p < length; p++) {
            inputK = input[inputPos++]; // K
            input0 = input[inputPos++]; // C
            input1 = input[inputPos++]; // M
            input2 = input[inputPos++]; // Y

            // Q0.8 grid coords with 4-axis input===255 boundary patches.
            // The K-axis patch (inputK===255) is in the K-interp guard
            // below: when inputK===255 we set K0=maxK and force interpK
            // off, since there's no "K1 plane above the top of the LUT".
            pk = Math.imul(inputK, gps);
            if (inputK === 255) { K0 = maxK; rk = 0; }
            else { K0 = pk >>> 16; rk = (pk >>> 8) & 0xFF; K0 = Math.imul(K0, go3); }

            px = Math.imul(input0, gps);
            if (input0 === 255) { X0 = maxX; X1 = maxX; rx = 0; }
            else { X0 = px >>> 16; rx = (px >>> 8) & 0xFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

            py = Math.imul(input1, gps);
            if (input1 === 255) { Y0 = maxY; Y1 = maxY; ry = 0; }
            else { Y0 = py >>> 16; ry = (py >>> 8) & 0xFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

            pz = Math.imul(input2, gps);
            if (input2 === 255) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
            else { Z0 = pz >>> 16; rz = (pz >>> 8) & 0xFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

            base1 = X0 + Y0 + Z0 + K0;
            c0 = CLUT[base1++]; c1 = CLUT[base1++]; c2 = CLUT[base1];

            if (inputK === 255 || rk === 0) {
                interpK = false;
            } else {
                base1 += kOffset;
                d0 = CLUT[base1++]; d1 = CLUT[base1++]; d2 = CLUT[base1];
                interpK = true;
            }

            // Six tetrahedral cases. Each case does:
            //   1. 3D interp at K0 plane → o0/o1/o2 in u16 scale
            //   2. if interpK: 3D interp at K1 plane (inline) + K-LERP →
            //      final u8 via two-step rounding
            //   3. else: final u8 from o via single-step rounding
            // The 3D-interp form mirrors the 3D 3Ch intLut kernel exactly;
            // only the +K0 in base offsets and the K-interp tail are new.
            // Tetrahedral inner-interp produces o0/o1/o2 at u20 (Q16.4)
            // scale: o = (corner << 4) + ((sum + 0x08) >> 4). The inner
            // `>> 4` is a negligible 1/16-LSB-of-u16 rounding step.
            // Final u8 is one meaningful rounding step away:
            //   - interpK: ((o << 8) + imul(K1_u20 - o, rk) + 0x80000) >> 20
            //   - non-interpK: (o + 0x800) >> 12
            // See INTEGER HOT PATH header for the full derivation and
            // int32-overflow analysis behind the u20 choice.
            if (rx >= ry && ry >= rz) {
                base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
                a = CLUT[base1++]; b = CLUT[base2++];
                o0 = (c0 << 4) + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                a = CLUT[base1++]; b = CLUT[base2++];
                o1 = (c1 << 4) + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                a = CLUT[base1];   b = CLUT[base2];
                o2 = (c2 << 4) + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x08) >> 4);
                if (interpK) {
                    base1 += kOffset; base2 += kOffset; base4 += kOffset;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((o0 << 8) + Math.imul(((d0 << 4) + ((Math.imul(a - d0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((o1 << 8) + Math.imul(((d1 << 4) + ((Math.imul(a - d1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((o2 << 8) + Math.imul(((d2 << 4) + ((Math.imul(a - d2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                } else {
                    output[outputPos++] = (o0 + 0x800) >> 12;
                    output[outputPos++] = (o1 + 0x800) >> 12;
                    output[outputPos++] = (o2 + 0x800) >> 12;
                }
            } else if (rx >= rz && rz >= ry) {
                base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z1 + K0; base3 = X1 + Y0 + Z1 + K0;
                a = CLUT[base3++]; b = CLUT[base1++];
                o0 = (c0 << 4) + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                a = CLUT[base3++]; b = CLUT[base1++];
                o1 = (c1 << 4) + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                a = CLUT[base3];   b = CLUT[base1];
                o2 = (c2 << 4) + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                if (interpK) {
                    base3 += kOffset; base1 += kOffset; base2 += kOffset;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = ((o0 << 8) + Math.imul(((d0 << 4) + ((Math.imul(b - d0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = ((o1 << 8) + Math.imul(((d1 << 4) + ((Math.imul(b - d1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = ((o2 << 8) + Math.imul(((d2 << 4) + ((Math.imul(b - d2, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                } else {
                    output[outputPos++] = (o0 + 0x800) >> 12;
                    output[outputPos++] = (o1 + 0x800) >> 12;
                    output[outputPos++] = (o2 + 0x800) >> 12;
                }
            } else if (rx >= ry && rz >= rx) {
                base1 = X1 + Y0 + Z1 + K0; base2 = X0 + Y0 + Z1 + K0; base3 = X1 + Y1 + Z1 + K0;
                a = CLUT[base1++]; b = CLUT[base2++];
                o0 = (c0 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x08) >> 4);
                a = CLUT[base1++]; b = CLUT[base2++];
                o1 = (c1 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x08) >> 4);
                a = CLUT[base1];   b = CLUT[base2];
                o2 = (c2 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c2, rz) + 0x08) >> 4);
                if (interpK) {
                    base1 += kOffset; base2 += kOffset; base3 += kOffset;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((o0 << 8) + Math.imul(((d0 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - d0, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((o1 << 8) + Math.imul(((d1 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - d1, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((o2 << 8) + Math.imul(((d2 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - d2, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                } else {
                    output[outputPos++] = (o0 + 0x800) >> 12;
                    output[outputPos++] = (o1 + 0x800) >> 12;
                    output[outputPos++] = (o2 + 0x800) >> 12;
                }
            } else if (ry >= rx && rx >= rz) {
                base1 = X1 + Y1 + Z0 + K0; base2 = X0 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
                a = CLUT[base2++]; b = CLUT[base1++];
                o0 = (c0 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                a = CLUT[base2++]; b = CLUT[base1++];
                o1 = (c1 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                a = CLUT[base2];   b = CLUT[base1];
                o2 = (c2 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x08) >> 4);
                if (interpK) {
                    base1 += kOffset; base2 += kOffset; base4 += kOffset;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = ((o0 << 8) + Math.imul(((d0 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - d0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = ((o1 << 8) + Math.imul(((d1 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - d1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = ((o2 << 8) + Math.imul(((d2 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - d2, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                } else {
                    output[outputPos++] = (o0 + 0x800) >> 12;
                    output[outputPos++] = (o1 + 0x800) >> 12;
                    output[outputPos++] = (o2 + 0x800) >> 12;
                }
            } else if (ry >= rz && rz >= rx) {
                base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base3 = X0 + Y1 + Z0 + K0;
                a = CLUT[base2++]; b = CLUT[base3++];
                o0 = (c0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                a = CLUT[base2++]; b = CLUT[base3++];
                o1 = (c1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                a = CLUT[base2];   b = CLUT[base3];
                o2 = (c2 << 4) + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                if (interpK) {
                    base1 += kOffset; base2 += kOffset; base3 += kOffset;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = ((o0 << 8) + Math.imul(((d0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - d0, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = ((o1 << 8) + Math.imul(((d1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - d1, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = ((o2 << 8) + Math.imul(((d2 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - d2, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                } else {
                    output[outputPos++] = (o0 + 0x800) >> 12;
                    output[outputPos++] = (o1 + 0x800) >> 12;
                    output[outputPos++] = (o2 + 0x800) >> 12;
                }
            } else if (rz >= ry && ry >= rx) {
                base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base4 = X0 + Y0 + Z1 + K0;
                a = CLUT[base2++]; b = CLUT[base4++];
                o0 = (c0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x08) >> 4);
                a = CLUT[base2++]; b = CLUT[base4++];
                o1 = (c1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x08) >> 4);
                a = CLUT[base2];   b = CLUT[base4];
                o2 = (c2 << 4) + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x08) >> 4);
                if (interpK) {
                    base1 += kOffset; base2 += kOffset; base4 += kOffset;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = ((o0 << 8) + Math.imul(((d0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - d0, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = ((o1 << 8) + Math.imul(((d1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - d1, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = ((o2 << 8) + Math.imul(((d2 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - d2, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                } else {
                    output[outputPos++] = (o0 + 0x800) >> 12;
                    output[outputPos++] = (o1 + 0x800) >> 12;
                    output[outputPos++] = (o2 + 0x800) >> 12;
                }
            } else {
                // Degenerate rx==ry==rz path. Mirrors the float kernel's
                // K-only LERP (no 3D interp needed when all weights equal).
                // Also fixes a pre-existing rounding-bias bug: the +0x80
                // was correct for >> 8 but wrong for >> 16 (half of 2^16
                // is 0x8000). Contributed ≤1 LSB drift on this branch.
                if (interpK) {
                    output[outputPos++] = ((c0 << 8) + Math.imul(d0 - c0, rk) + 0x8000) >> 16;
                    output[outputPos++] = ((c1 << 8) + Math.imul(d1 - c1, rk) + 0x8000) >> 16;
                    output[outputPos++] = ((c2 << 8) + Math.imul(d2 - c2, rk) + 0x8000) >> 16;
                } else {
                    output[outputPos++] = (c0 + 0x80) >> 8;
                    output[outputPos++] = (c1 + 0x80) >> 8;
                    output[outputPos++] = (c2 + 0x80) >> 8;
                }
            }

            if(preserveAlpha) {
                output[outputPos++] = input[inputPos++];
            } else {
                if(inputHasAlpha)  { inputPos++;  }
                if(outputHasAlpha) {
                    output[outputPos++] = 255;
                }
            }
        }
    };

    /**
     * INT HOT PATH. 4D LUT, 4-channel input → 4-channel output.
     * Integer-math sibling of tetrahedralInterp4DArray_4Ch_loop.
     * Used when lutMode='int' is set. Typical use: CMYK → CMYK
     * profile-to-profile re-purposing (SWOP → GRACoL etc).
     *
     * Same u20 single-rounding design as the 4D 3Ch intLut kernel
     * above — see that JSDoc for the derivation and int32 overflow
     * analysis. Differences here:
     *   - Reads 4 LUT values per sub-block (one extra channel write)
     *   - Uses k0..k3 instead of d0..d2 for K1 plane corners (matches
     *     float kernel's variable naming)
     *
     * Accuracy on GRACoL2006 → GRACoL2006 (65k random pixels,
     * bench/fastLUT_real_world.js): 95.89 % bit-exact vs float, max
     * 1 LSB drift on the remaining 4.11 %, zero channels off by ≥2.
     */
    tetrahedralInterp4DArray_4Ch_intLut_loop(input, inputPos, output, outputPos, length, intLut, inputHasAlpha, outputHasAlpha, preserveAlpha){
        var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0, K0 = 0|0;
        var rx = 0|0, ry = 0|0, rz = 0|0, rk = 0|0;
        var px = 0|0, py = 0|0, pz = 0|0, pk = 0|0;
        var input0 = 0|0, input1 = 0|0, input2 = 0|0, inputK = 0|0;
        var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
        var c0 = 0|0, c1 = 0|0, c2 = 0|0, c3 = 0|0;
        var k0 = 0|0, k1 = 0|0, k2 = 0|0, k3 = 0|0;
        var o0 = 0|0, o1 = 0|0, o2 = 0|0, o3 = 0|0;
        var a = 0|0, b = 0|0;
        var interpK = false;

        var gps  = intLut.gridPointsScale_fixed | 0;
        var CLUT = intLut.CLUT;
        var go0  = intLut.go0 | 0;
        var go1  = intLut.go1 | 0;
        var go2  = intLut.go2 | 0;
        var go3  = intLut.go3 | 0;
        var maxX = intLut.maxX | 0;
        var maxY = intLut.maxY | 0;
        var maxZ = intLut.maxZ | 0;
        var maxK = intLut.maxK | 0;
        var kOffset = (go3 - intLut.outputChannels + 1) | 0;

        for(var p = 0; p < length; p++) {
            inputK = input[inputPos++]; // K
            input0 = input[inputPos++]; // C
            input1 = input[inputPos++]; // M
            input2 = input[inputPos++]; // Y

            pk = Math.imul(inputK, gps);
            if (inputK === 255) { K0 = maxK; rk = 0; }
            else { K0 = pk >>> 16; rk = (pk >>> 8) & 0xFF; K0 = Math.imul(K0, go3); }

            px = Math.imul(input0, gps);
            if (input0 === 255) { X0 = maxX; X1 = maxX; rx = 0; }
            else { X0 = px >>> 16; rx = (px >>> 8) & 0xFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

            py = Math.imul(input1, gps);
            if (input1 === 255) { Y0 = maxY; Y1 = maxY; ry = 0; }
            else { Y0 = py >>> 16; ry = (py >>> 8) & 0xFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

            pz = Math.imul(input2, gps);
            if (input2 === 255) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
            else { Z0 = pz >>> 16; rz = (pz >>> 8) & 0xFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

            base1 = X0 + Y0 + Z0 + K0;
            c0 = CLUT[base1++]; c1 = CLUT[base1++]; c2 = CLUT[base1++]; c3 = CLUT[base1];

            if (inputK === 255 || rk === 0) {
                interpK = false;
            } else {
                base1 += kOffset;
                k0 = CLUT[base1++]; k1 = CLUT[base1++]; k2 = CLUT[base1++]; k3 = CLUT[base1];
                interpK = true;
            }

            // Same u20 (Q16.4) single-rounding design as the 4D 3Ch
            // intLut kernel above. Inner 3D interp lands o0..o3 at u20
            // scale, then the K-LERP folds K1 plane interp and final
            // u8 rounding into one `+0x80000) >> 20` operation.
            if (rx >= ry && ry >= rz) {
                base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
                a = CLUT[base1++]; b = CLUT[base2++];
                o0 = (c0 << 4) + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                a = CLUT[base1++]; b = CLUT[base2++];
                o1 = (c1 << 4) + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                a = CLUT[base1++]; b = CLUT[base2++];
                o2 = (c2 << 4) + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                a = CLUT[base1];   b = CLUT[base2];
                o3 = (c3 << 4) + ((Math.imul(a - c3, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x08) >> 4);
                if (interpK) {
                    base1 += kOffset; base2 += kOffset; base4 += kOffset;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((o0 << 8) + Math.imul(((k0 << 4) + ((Math.imul(a - k0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((o1 << 8) + Math.imul(((k1 << 4) + ((Math.imul(a - k1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((o2 << 8) + Math.imul(((k2 << 4) + ((Math.imul(a - k2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                    a = CLUT[base1];   b = CLUT[base2];
                    output[outputPos++] = ((o3 << 8) + Math.imul(((k3 << 4) + ((Math.imul(a - k3, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x08) >> 4)) - o3, rk) + 0x80000) >> 20;
                } else {
                    output[outputPos++] = (o0 + 0x800) >> 12;
                    output[outputPos++] = (o1 + 0x800) >> 12;
                    output[outputPos++] = (o2 + 0x800) >> 12;
                    output[outputPos++] = (o3 + 0x800) >> 12;
                }
            } else if (rx >= rz && rz >= ry) {
                base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z1 + K0; base3 = X1 + Y0 + Z1 + K0;
                a = CLUT[base3++]; b = CLUT[base1++];
                o0 = (c0 << 4) + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                a = CLUT[base3++]; b = CLUT[base1++];
                o1 = (c1 << 4) + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                a = CLUT[base3++]; b = CLUT[base1++];
                o2 = (c2 << 4) + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                a = CLUT[base3];   b = CLUT[base1];
                o3 = (c3 << 4) + ((Math.imul(b - c3, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                if (interpK) {
                    base3 += kOffset; base1 += kOffset; base2 += kOffset;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = ((o0 << 8) + Math.imul(((k0 << 4) + ((Math.imul(b - k0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = ((o1 << 8) + Math.imul(((k1 << 4) + ((Math.imul(b - k1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = ((o2 << 8) + Math.imul(((k2 << 4) + ((Math.imul(b - k2, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                    a = CLUT[base3];   b = CLUT[base1];
                    output[outputPos++] = ((o3 << 8) + Math.imul(((k3 << 4) + ((Math.imul(b - k3, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o3, rk) + 0x80000) >> 20;
                } else {
                    output[outputPos++] = (o0 + 0x800) >> 12;
                    output[outputPos++] = (o1 + 0x800) >> 12;
                    output[outputPos++] = (o2 + 0x800) >> 12;
                    output[outputPos++] = (o3 + 0x800) >> 12;
                }
            } else if (rx >= ry && rz >= rx) {
                base1 = X1 + Y0 + Z1 + K0; base2 = X0 + Y0 + Z1 + K0; base3 = X1 + Y1 + Z1 + K0;
                a = CLUT[base1++]; b = CLUT[base2++];
                o0 = (c0 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x08) >> 4);
                a = CLUT[base1++]; b = CLUT[base2++];
                o1 = (c1 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x08) >> 4);
                a = CLUT[base1++]; b = CLUT[base2++];
                o2 = (c2 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c2, rz) + 0x08) >> 4);
                a = CLUT[base1];   b = CLUT[base2];
                o3 = (c3 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c3, rz) + 0x08) >> 4);
                if (interpK) {
                    base1 += kOffset; base2 += kOffset; base3 += kOffset;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((o0 << 8) + Math.imul(((k0 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - k0, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((o1 << 8) + Math.imul(((k1 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - k1, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((o2 << 8) + Math.imul(((k2 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - k2, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                    a = CLUT[base1];   b = CLUT[base2];
                    output[outputPos++] = ((o3 << 8) + Math.imul(((k3 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - k3, rz) + 0x08) >> 4)) - o3, rk) + 0x80000) >> 20;
                } else {
                    output[outputPos++] = (o0 + 0x800) >> 12;
                    output[outputPos++] = (o1 + 0x800) >> 12;
                    output[outputPos++] = (o2 + 0x800) >> 12;
                    output[outputPos++] = (o3 + 0x800) >> 12;
                }
            } else if (ry >= rx && rx >= rz) {
                base1 = X1 + Y1 + Z0 + K0; base2 = X0 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
                a = CLUT[base2++]; b = CLUT[base1++];
                o0 = (c0 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                a = CLUT[base2++]; b = CLUT[base1++];
                o1 = (c1 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                a = CLUT[base2++]; b = CLUT[base1++];
                o2 = (c2 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                a = CLUT[base2];   b = CLUT[base1];
                o3 = (c3 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - c3, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x08) >> 4);
                if (interpK) {
                    base1 += kOffset; base2 += kOffset; base4 += kOffset;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = ((o0 << 8) + Math.imul(((k0 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - k0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = ((o1 << 8) + Math.imul(((k1 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - k1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = ((o2 << 8) + Math.imul(((k2 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - k2, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                    a = CLUT[base2];   b = CLUT[base1];
                    output[outputPos++] = ((o3 << 8) + Math.imul(((k3 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - k3, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x08) >> 4)) - o3, rk) + 0x80000) >> 20;
                } else {
                    output[outputPos++] = (o0 + 0x800) >> 12;
                    output[outputPos++] = (o1 + 0x800) >> 12;
                    output[outputPos++] = (o2 + 0x800) >> 12;
                    output[outputPos++] = (o3 + 0x800) >> 12;
                }
            } else if (ry >= rz && rz >= rx) {
                base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base3 = X0 + Y1 + Z0 + K0;
                a = CLUT[base2++]; b = CLUT[base3++];
                o0 = (c0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                a = CLUT[base2++]; b = CLUT[base3++];
                o1 = (c1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                a = CLUT[base2++]; b = CLUT[base3++];
                o2 = (c2 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                a = CLUT[base2];   b = CLUT[base3];
                o3 = (c3 << 4) + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c3, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                if (interpK) {
                    base1 += kOffset; base2 += kOffset; base3 += kOffset;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = ((o0 << 8) + Math.imul(((k0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - k0, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = ((o1 << 8) + Math.imul(((k1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - k1, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = ((o2 << 8) + Math.imul(((k2 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - k2, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                    a = CLUT[base2];   b = CLUT[base3];
                    output[outputPos++] = ((o3 << 8) + Math.imul(((k3 << 4) + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - k3, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o3, rk) + 0x80000) >> 20;
                } else {
                    output[outputPos++] = (o0 + 0x800) >> 12;
                    output[outputPos++] = (o1 + 0x800) >> 12;
                    output[outputPos++] = (o2 + 0x800) >> 12;
                    output[outputPos++] = (o3 + 0x800) >> 12;
                }
            } else if (rz >= ry && ry >= rx) {
                base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base4 = X0 + Y0 + Z1 + K0;
                a = CLUT[base2++]; b = CLUT[base4++];
                o0 = (c0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x08) >> 4);
                a = CLUT[base2++]; b = CLUT[base4++];
                o1 = (c1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x08) >> 4);
                a = CLUT[base2++]; b = CLUT[base4++];
                o2 = (c2 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x08) >> 4);
                a = CLUT[base2];   b = CLUT[base4];
                o3 = (c3 << 4) + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c3, rz) + 0x08) >> 4);
                if (interpK) {
                    base1 += kOffset; base2 += kOffset; base4 += kOffset;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = ((o0 << 8) + Math.imul(((k0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - k0, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = ((o1 << 8) + Math.imul(((k1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - k1, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = ((o2 << 8) + Math.imul(((k2 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - k2, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                    a = CLUT[base2];   b = CLUT[base4];
                    output[outputPos++] = ((o3 << 8) + Math.imul(((k3 << 4) + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - k3, rz) + 0x08) >> 4)) - o3, rk) + 0x80000) >> 20;
                } else {
                    output[outputPos++] = (o0 + 0x800) >> 12;
                    output[outputPos++] = (o1 + 0x800) >> 12;
                    output[outputPos++] = (o2 + 0x800) >> 12;
                    output[outputPos++] = (o3 + 0x800) >> 12;
                }
            } else {
                // Degenerate rx==ry==rz K-only LERP.
                // Fixes pre-existing rounding-bias bug: +0x80 was wrong
                // for >> 16 (half of 2^16 is 0x8000).
                if (interpK) {
                    output[outputPos++] = ((c0 << 8) + Math.imul(k0 - c0, rk) + 0x8000) >> 16;
                    output[outputPos++] = ((c1 << 8) + Math.imul(k1 - c1, rk) + 0x8000) >> 16;
                    output[outputPos++] = ((c2 << 8) + Math.imul(k2 - c2, rk) + 0x8000) >> 16;
                    output[outputPos++] = ((c3 << 8) + Math.imul(k3 - c3, rk) + 0x8000) >> 16;
                } else {
                    output[outputPos++] = (c0 + 0x80) >> 8;
                    output[outputPos++] = (c1 + 0x80) >> 8;
                    output[outputPos++] = (c2 + 0x80) >> 8;
                    output[outputPos++] = (c3 + 0x80) >> 8;
                }
            }

            if(preserveAlpha) {
                output[outputPos++] = input[inputPos++];
            } else {
                if(inputHasAlpha)  { inputPos++;  }
                if(outputHasAlpha) {
                    output[outputPos++] = 255;
                }
            }
        }
    };


    tetrahedralInterp3DArray_4Ch_16bit(input, inputPos, output, outputPos, length, lut){
        var rx,ry,rz;
        var X0,X1,Y0,Y1,Z0,Z1,px,py,pz, input0, input1, input2
        var base1,base2,
            c00,c01,c02,c03,
            c10,c11,c12,c13,
            c20,c21,c22,c23,
            c30,c31,c32,c33;

        var outputScale = lut.outputScale;
        var outputChannels = lut.outputChannels;
        var gridPointsMinus1 = lut.g1 - 1;
        var CLUT = lut.CLUT;
        var go1 = lut.go1;
        var go2 = lut.go2;

        for(var p = 0; p < length; p++) {

            // We need some clipping here
            input0 = input[inputPos++];
            input1 = input[inputPos++];
            input2 = input[inputPos++];

            // No clipping checks for speed needed for clamped arrays

            px = input0 * gridPointsMinus1 / 255;
            py = input1 * gridPointsMinus1 / 255;
            pz = input2 * gridPointsMinus1 / 255;

            X0 = Math.floor(px);
            rx = input0;
            X1 = (input0  === 255) ? X0 : X0 + 1;

            Y0 = Math.floor(py);
            ry = input1;
            Y1 = (input1  === 255) ? Y0 : Y0 + 1;

            Z0 = Math.floor(pz);
            rz = input2;
            Z1 = (input2  === 255) ? Z0 : Z0 + 1;

            Z0 *= outputChannels;
            Z1 *= outputChannels;

            //c0 = lookup(X0, Y0, Z0);
            base1 = ((X0 * go2) + (Y0 * go1) + Z0);
            c00 = CLUT[base1++];
            c01 = CLUT[base1++];
            c02 = CLUT[base1++];
            c03 = CLUT[base1];

            if (rx >= ry && ry >= rz) {
                // block1
                // X1, Y0, Z0, c0);
                base1 = ((X1 * go2) + (Y0 * go1) + Z0);
                c10 = CLUT[base1++] - c00;
                c11 = CLUT[base1++] - c01;
                c12 = CLUT[base1++] - c02;
                c13 = CLUT[base1] - c03;

                // X1, Y1, Z0,
                // X1, Y0, Z0);
                base1 = ((X1 * go2) + (Y1 * go1) + Z0);
                base2 = ((X1 * go2) + (Y0 * go1) + Z0);
                c20 = CLUT[base1++] - CLUT[base2++];
                c21 = CLUT[base1++] - CLUT[base2++];
                c22 = CLUT[base1++] - CLUT[base2++];
                c23 = CLUT[base1] - CLUT[base2];

                // X1, Y1, Z1,
                // X1, Y1, Z0);
                base1 = ((X1 * go2) + (Y1 * go1) + Z1);
                base2 = ((X1 * go2) + (Y1 * go1) + Z0);
                c30 = CLUT[base1++] - CLUT[base2++];
                c31 = CLUT[base1++] - CLUT[base2++];
                c32 = CLUT[base1++] - CLUT[base2++];
                c33 = CLUT[base1] - CLUT[base2]

            } else if (rx >= rz && rz >= ry) {
                // block2
                // X1, Y0, Z0, c0);
                base1 = ((X1 * go2) + (Y0 * go1) + Z0);
                c10 = CLUT[base1++] - c00;
                c11 = CLUT[base1++] - c01;
                c12 = CLUT[base1++] - c02;
                c13 = CLUT[base1] - c03;

                // X1, Y1, Z1,
                // X1, Y0, Z1)
                base1 = ((X1 * go2) + (Y1 * go1) + Z1);
                base2 = ((X1 * go2) + (Y0 * go1) + Z1);
                c20 = CLUT[base1++] - CLUT[base2++];
                c21 = CLUT[base1++] - CLUT[base2++];
                c22 = CLUT[base1++] - CLUT[base2++];
                c23 = CLUT[base1] - CLUT[base2];

                // X1, Y0, Z1,
                // X1, Y0, Z0);
                base1 = ((X1 * go2) + (Y0 * go1) + Z1);
                base2 = ((X1 * go2) + (Y0 * go1) + Z0);
                c30 = CLUT[base1++] - CLUT[base2++];
                c31 = CLUT[base1++] - CLUT[base2++];
                c32 = CLUT[base1++] - CLUT[base2++];
                c33 = CLUT[base1] - CLUT[base2]

            } else if (rz >= rx && rx >= ry) {
                // block3
                // X1, Y0, Z1,
                // X0, Y0, Z1);
                base1 = ((X1 * go2) + (Y0 * go1) + Z1);
                base2 = ((X0 * go2) + (Y0 * go1) + Z1);
                c10 = CLUT[base1++] - CLUT[base2++];
                c11 = CLUT[base1++] - CLUT[base2++];
                c12 = CLUT[base1++] - CLUT[base2++];
                c13 = CLUT[base1] - CLUT[base2];

                // X1, Y1, Z1,
                // X1, Y0, Z1);
                base1 = ((X1 * go2) + (Y1 * go1) + Z1);
                base2 = ((X1 * go2) + (Y0 * go1) + Z1);
                c20 = CLUT[base1++] - CLUT[base2++];
                c21 = CLUT[base1++] - CLUT[base2++];
                c22 = CLUT[base1++] - CLUT[base2++];
                c23 = CLUT[base1] - CLUT[base2];

                // X0, Y0, Z1, c0);
                base1 = ((X0 * go2) + (Y0 * go1) + Z1);
                c30 = CLUT[base1++] - c00;
                c31 = CLUT[base1++] - c01;
                c32 = CLUT[base1++] - c02;
                c33 = CLUT[base1] - c03;

            } else if (ry >= rx && rx >= rz) {
                // block4

                //  X1, Y1, Z0,
                //  X0, Y1, Z0);
                base1 = ((X1 * go2) + (Y1 * go1) + Z0);
                base2 = ((X0 * go2) + (Y1 * go1) + Z0);
                c10 = CLUT[base1++] - CLUT[base2++];
                c11 = CLUT[base1++] - CLUT[base2++];
                c12 = CLUT[base1++] - CLUT[base2++];
                c13 = CLUT[base1++] - CLUT[base2];

                // X0, Y1, Z0, c0);
                base1 = ((X0 * go2) + (Y1 * go1) + Z0);
                c20 = CLUT[base1++] - c00;
                c21 = CLUT[base1++] - c01;
                c22 = CLUT[base1++] - c02;
                c23 = CLUT[base1] - c03;

                // X1, Y1, Z1,
                // X1, Y1, Z0);
                base1 = ((X1 * go2) + (Y1 * go1) + Z1);
                base2 = ((X1 * go2) + (Y1 * go1) + Z0);
                c30 = CLUT[base1++] - CLUT[base2++];
                c31 = CLUT[base1++] - CLUT[base2++];
                c32 = CLUT[base1++] - CLUT[base2++];
                c33 = CLUT[base1] - CLUT[base2]

            } else if (ry >= rz && rz >= rx) {
                // block5

                //  X1, Y1, Z1,
                //  X0, Y1, Z1);
                base1 = ((X1 * go2) + (Y1 * go1) + Z1);
                base2 = ((X0 * go2) + (Y1 * go1) + Z1);
                c10 = CLUT[base1++] - CLUT[base2++];
                c11 = CLUT[base1++] - CLUT[base2++];
                c12 = CLUT[base1++] - CLUT[base2++];
                c13 = CLUT[base1] - CLUT[base2];

                // X0, Y1, Z0, c0);
                base1 = ((X0 * go2) + (Y1 * go1) + Z0);
                c20 = CLUT[base1++] - c00;
                c21 = CLUT[base1++] - c01;
                c22 = CLUT[base1++] - c02;
                c23 = CLUT[base1] - c03;

                // X0, Y1, Z1,
                // X0, Y1, Z0);
                base1 = ((X0 * go2) + (Y1 * go1) + Z1);
                base2 = ((X0 * go2) + (Y1 * go1) + Z0) ;
                c30 = CLUT[base1++] - CLUT[base2++];
                c31 = CLUT[base1++] - CLUT[base2++];
                c32 = CLUT[base1++] - CLUT[base2++];
                c33 = CLUT[base1] - CLUT[base2]

            } else if (rz >= ry && ry >= rx) {
                // block6

                //   X1, Y1, Z1,
                //   X0, Y1, Z1);
                base1 = ((X1 * go2) + (Y1 * go1) + Z1);
                base2 = ((X0 * go2) + (Y1 * go1) + Z1);
                c10 = CLUT[base1++] - CLUT[base2++];
                c11 = CLUT[base1++] - CLUT[base2++];
                c12 = CLUT[base1++] - CLUT[base2++];
                c13 = CLUT[base1] - CLUT[base2];

                //  X0, Y1, Z1,
                //  X0, Y0, Z1);
                base1 = ((X0 * go2) + (Y1 * go1) + Z1);
                base2 = ((X0 * go2) + (Y0 * go1) + Z1);
                c20 = CLUT[base1++] - CLUT[base2++];
                c21 = CLUT[base1++] - CLUT[base2++];
                c22 = CLUT[base1++] - CLUT[base2++];
                c23 = CLUT[base1] - CLUT[base2];

                //X0, Y0, Z1, c0
                base1 = ((X0 * go2) + (Y0 * go1) + Z1);
                c30 = CLUT[base1++] - c00;
                c31 = CLUT[base1++] - c01;
                c32 = CLUT[base1++] - c02;
                c33 = CLUT[base1] - c03;

            } else {
                output[outputPos++] = c00 * outputScale;
                output[outputPos++] = c01 * outputScale;
                output[outputPos++] = c02 * outputScale;
                output[outputPos++] = c03 * outputScale;
                continue;
            }

            // Output should be computed as x = ROUND_FIXED_TO_INT(_cmsToFixedDomain(Rest))
            // which expands as: x = (Rest + ((Rest+0x7fff)/0xFFFF) + 0x8000)>>16
            // This can be replaced by: t = Rest+0x8001, x = (t + (t>>16))>>16
            // at the cost of being off by one at 7fff and 17ffe.
            var t;
            t = (c10 * rx) + (c20 * ry) + (c30 * rz) + 0x8001; // 24 bits
            output[outputPos++] = ((c00 * 256) + t + (t>>16)) >> 16;

            t = (c11 * rx) + (c21 * ry) + (c31 * rz) + 0x8001; // 24 bits
            output[outputPos++] = ((c01 * 256) + t + (t>>16)) >> 16;

            t = (c12 * rx) + (c22 * ry) + (c32 * rz) + 0x8001; // 24 bits
            output[outputPos++] = ((c02 * 256) + t + (t>>16)) >> 16;

            t = (c13 * rx) + (c23 * ry) + (c33 * rz) + 0x8001; // 24 bits
            output[outputPos++] = ((c03 * 256) + t + (t>>16)) >> 16;

            // output[outputPos++] = ((c00 * 256) + (c10 * rx) + (c20 * ry) + (c30 * rz)) >> 16;
        }
    };

    tetrahedralInterp3D_NCh_F16(input16, lut){
        var rx,ry,rz;
        var X0,X1,Y0,Y1,Z0,Z1,px,py,pz, input0, input1, input2
        var base0, base1,base2, base3, base4,
            a, b, c, o

        var outputScale = lut.outputScale;
        var outputChannels = lut.outputChannels;
        var gridEnd = (lut.g1 - 1);
        var CLUT = lut.CLUT;
        var go0 = lut.go0;
        var go1 = lut.go1;
        var go2 = lut.go2;

        // We need some clipping here
        input0 = Math.min(Math.max(input16[0], 0), 0xFFFF);
        input1 = Math.min(Math.max(input16[1], 0), 0xFFFF);
        input2 = Math.min(Math.max(input16[2], 0), 0xFFFF);

        // only px needs to be a float
        px = input0 * gridEnd / 0xFFFF;
        py = input1 * gridEnd / 0xFFFF;
        pz = input2 * gridEnd / 0xFFFF;

        X0 = ~~px; //~~ is the same as Math.floor(px)
        rx = (px - X0); // get the fractional part
        if(X0 === gridEnd){
            X1 = X0 *= go2;// change to index in array
        } else {
            X0 *= go2;
            X1 = X0 + go2;
        }

        Y0 = ~~py;
        ry = (py - Y0);
        if(Y0 === gridEnd){
            Y1 = Y0 *= go1;
        } else {
            Y0 *= go1;
            Y1 = Y0 + go1;
        }

        Z0 = ~~pz;
        rz = (pz - Z0);
        if(Z0 === gridEnd){
            Z1 = Z0 *= go0;
        } else {
            Z0 *= go0;
            Z1 = Z0 + go0;
        }

        // Starting point
        base0 = X0 + Y0 + Z0;

        var output = new Array(outputChannels);

        if (rx >= ry && ry >= rz) {
            // block1
            base1 = X1 + Y0 + Z0;
            base2 = X1 + Y1 + Z0;
            base4 = X1 + Y1 + Z1;
            for(o = 0; o < outputChannels; o++){
                a = CLUT[base1++];
                b = CLUT[base2++];
                c = CLUT[base0++];
                output[o] = (c + ((a - c) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;
            }

        } else if (rx >= rz && rz >= ry) {
            // block2

            base1 = X1 + Y0 + Z0;
            base2 = X1 + Y1 + Z1;
            base3 = X1 + Y0 + Z1;
            for(o = 0; o < outputChannels; o++){
                a = CLUT[base3++];
                b = CLUT[base1++];
                c = CLUT[base0++];
                output[o] = (c + ((b - c) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz)) * outputScale;
            }

        } else if (rx >= ry && rz >= rx) {
            // block3

            base1 = X1 + Y0 + Z1;
            base2 = X0 + Y0 + Z1;
            base3 = X1 + Y1 + Z1;
            for(o = 0; o < outputChannels; o++){
                a = CLUT[base1++];
                b = CLUT[base2++];
                c = CLUT[base0++];
                output[o] = (c + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c) * rz)) * outputScale;
            }

        } else if (ry >= rx && rx >= rz) {
            // block4

            base1 = X1 + Y1 + Z0;
            base2 = X0 + Y1 + Z0;
            base4 = X1 + Y1 + Z1;
            for(o = 0; o < outputChannels; o++){
                a = CLUT[base2++];
                b = CLUT[base1++];
                c = CLUT[base0++];
                output[o] = (c + ((b - a) * rx) + ((a - c) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;
            }

        } else if (ry >= rz && rz >= rx) {
            // block5

            base1 = X1 + Y1 + Z1;
            base2 = X0 + Y1 + Z1;
            base3 = X0 + Y1 + Z0;
            for(o = 0; o < outputChannels; o++){
                a = CLUT[base2++];
                b = CLUT[base3++];
                c = CLUT[base0++];
                output[o] = (c + ((CLUT[base1++] - a) * rx) + ((b - c) * ry) + ((a - b) * rz)) * outputScale;
            }

        } else if (rz >= ry && ry >= rx) {
            // block6

            base1 = X1 + Y1 + Z1;
            base2 = X0 + Y1 + Z1;
            base4 = X0 + Y0 + Z1;
            for(o = 0; o < outputChannels; o++){
                a = CLUT[base2++]
                b = CLUT[base4++]
                c = CLUT[base0++];
                output[o] = (c + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c) * rz) ) * outputScale;
            }

        } else {
            for(o = 0; o < outputChannels; o++){
                output[o] = CLUT[base0++] * outputScale;
            }
        }

        return output;
    };


//UPDATED
    tetrahedralInterp4D_3or4Ch_Master(input, lut){
        /**
         * For more than 3 inputs (i.e., CMYK)
         * evaluate two 3-dimensional interpolations and then linearly interpolate between them.
         */
        var K0,K1, inputK, pk, rk;
        inputK = pk = Math.max(0.0, Math.min(1.0, input[0] * lut.inputScale));

        pk = pk * (lut.g1 - 1);
        K0 = Math.floor(pk);
        rk = pk - K0;
        K1 = (inputK >= 1.0) ? K0 : K0 + 1;

        var cmyInput = [input[1], input[2], input[3]];

        var output1 = this.tetrahedralInterp3D_Master(cmyInput, lut, K0);
        // Such a small edge case where k===n/g1 perhaps faster without checking
        if(rk === 0){
            return output1;
        }
        var output2 = this.tetrahedralInterp3D_Master(cmyInput, lut, K1);

        // interpolate two results
        // Note that tetrahedralInterp3D already applies the output scale
        output1[0] = output1[0] + (( output2[0] - output1[0] ) * rk);
        output1[1] = output1[1] + (( output2[1] - output1[1] ) * rk);
        output1[2] = output1[2] + (( output2[2] - output1[2] ) * rk);
        if(lut.outputChannels === 3){
            return output1;
        }
        output1[3] = output1[3] + (( output2[3] - output1[3] ) * rk);
        return output1;
    };

    // todo - tetrahedralInterp5D, tetrahedralInterp6D ....
    /**
     * Generic tetrahedral 4D interpolation for 3D LUTs
     * @param input
     * @param lut
     * @returns {*}
     */
    //UPDATED
    tetrahedralInterp4D_3or4Ch(input, lut){
        /**
         * For more than 3 inputs (i.e., CMYK)
         * evaluate two 3-dimensional interpolations and then linearly interpolate between them.
         */
        var K0,K1, inputK, pk, rk;
        inputK = pk = Math.max(0.0, Math.min(1.0, input[0] * lut.inputScale));

        pk = pk * (lut.g1 - 1);
        K0 = Math.floor(pk);
        rk = pk - K0;
        K1 = (inputK >= 1.0) ? K0 : K0 + 1;

        var cmyInput = [input[1], input[2], input[3]];

        var output1 = this.tetrahedralInterp3D_3or4Ch(cmyInput, lut, K0);
        // Such a small edge case where k===n/g1 perhaps faster without checking
        if(rk === 0){
            return output1;
        }
        var output2 = this.tetrahedralInterp3D_3or4Ch(cmyInput, lut, K1);

        // interpolate two results
        // Note that tetrahedralInterp3D already applies the output scale
        output1[0] = output1[0] + (( output2[0] - output1[0] ) * rk);
        output1[1] = output1[1] + (( output2[1] - output1[1] ) * rk);
        output1[2] = output1[2] + (( output2[2] - output1[2] ) * rk);
        if(lut.outputChannels === 3){
            return output1;
        }
        output1[3] = output1[3] + (( output2[3] - output1[3] ) * rk);
        return output1;
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
            var device = transformLab2Device.forward(lab);
            var destLab = transformDevice2Lab.forward(device);
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
        var blackLab = transformDevice2Lab.forward(deviceBlack);
        var whiteLab = transformDevice2Lab.forward(deviceWhite);

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

        var device = transformLab2Device.forward(this.Lab(0,0,0));
        var blackLab = transformDevice2Lab.forward(device);

        if(blackLab.L > 50){
            blackLab.L = 50;
        }
        blackLab.a = blackLab.b = 0;

        return blackLab;
    };

}

////////////////////////////////////////////////////////////////////////////////
//
//  Helpers
//


function roundN(n, places) {
    var p = Math.pow(10, places)
    return Math.round(n * p) / p;
}


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


function data2String(color, format, precision){
    if(typeof precision === 'undefined'){
        precision = 6;
    }

    if(color === null){
        return '<NULL>';
    }

    if(color.type){
        return convert.cmsColor2String(color);
    }

    if(color.hasOwnProperty('L')){ // labD50 object {L:0, a:0, b:0}
        return 'LabD50: ' + n2str(color.L) + ', ' + n2str(color.a) + ', ' + n2str(color.b);
    }

    var str ='';
    for(var i=0;i < color.length; i++){
        switch(format){
            case 'r':
            case 'round':
                str += Math.round(color[i]);
                break;
            case 'f>16':
            case 'float>16':
                str += Math.round(color[i]*65535);
                break;
            case 'float':
            case 'f':
            default:
                // raw
                str += n2str(color[i], precision);
        }
        if(i<color.length - 1){
            str += ', ';
        }
    }
    return str;

    function n2str(n){
        return isNaN(n) ? n : n.toFixed(precision);
    }
}


module.exports = Transform;
