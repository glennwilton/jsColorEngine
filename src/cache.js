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

    // 0x9E3779B1 — nearest prime to 2^32 / phi. Knuth multiplicative hashing
    // (TAOCP Vol.3 6.4): the golden ratio is the hardest number to approximate
    // by a fraction, so clustered keys (which is exactly what neighbouring
    // pixels are) scatter evenly instead of piling into a few slots. Always
    // take the HIGH bits of the product — carries in a multiply only propagate
    // upward, so the low bits are barely mixed.
    var HASH_PRIME = 2654435761;

    // Scratch used to read a double's raw bits for hashing. The cache boundary
    // is not always device floats in 0..1 — depending on the input profile and
    // dataFormat the value there can be raw ints (0..255 / 0..65535), PCS
    // encodings, or Lab-scaled numbers. Quantising by a fixed multiplier
    // therefore degenerates: `v * 65536` on integer-valued input leaves the low
    // 16 bits zero, throwing away most of the entropy and collapsing distinct
    // colours into one slot. Hashing the bit pattern is scale-free, and equal
    // doubles always produce equal bits, which is what the table requires.
    // (+0 and -0 differ in bits but compare ===; that costs a miss, never a
    // wrong answer. Single-threaded and non-reentrant, so shared scratch is
    // safe — the write and both reads happen inside one expression.)
    var hashScratchFloat = new Float64Array(1);
    var hashScratchBits  = new Int32Array(hashScratchFloat.buffer);

    /**
     * ============================================================================
     *  Pixel cache — accuracy-path memoisation
     * ============================================================================
     *
     *  Design notes, measurements and the rejected alternatives live in
     *  docs/deepdive/PixelCache.md. What is implemented here:
     *
     *  TWO stages are injected, because the value worth caching does not exist
     *  at the point where the check has to happen:
     *
     *      [input conversion] [CHECK] ...maths... [STORE] [output conversion]
     *                            |                            ^
     *                            +----- hit: step = endStep ---+
     *
     *    - CHECK sits immediately after the input conversion, where the colour
     *      has become a plain numeric array. One implementation therefore
     *      covers object / objectFloat / int8 / int16 / device without any
     *      per-format code. On a hit it sets its own `step` so the walk jumps
     *      straight to the output conversion, skipping the maths and the STORE
     *      stage. On a miss it sets step = 1 and claims a slot.
     *    - STORE captures the finished value. It is only ever reached on a
     *      miss, because a hit jumps over it, so it needs no branch of its own.
     *
     *  The walk reads `stage.step` instead of incrementing, which is why it
     *  only runs under the dedicated arm in transform() / _walkPipelineCached.
     *  The default walk keeps its `i++` and pays nothing.
     *
     *  POSITIONS come from boundary markers (_pcAfterInput, _pcBeforeOutput)
     *  recorded during pipeline construction and resolved here by object
     *  identity. Indices cannot be recorded because optimisePipeline() merges
     *  stages and shifts them. Stage ENCODINGS cannot be scanned for either:
     *  the int output converters label their output 'device', and with
     *  dataFormat 'device' a Lab input profile starts the pipeline in PCSv4.
     *
     *  KEY SAFETY. The cache owns its arrays — keys and values are copied in,
     *  never referenced. That matters because with dataFormat 'device' the
     *  caller owns the input array and may mutate or reuse it between calls.
     *
     *  SLOT VALIDITY. On a miss CHECK writes the key but marks the entry
     *  invalid; STORE marks it valid. If a stage throws mid-pipeline the entry
     *  stays invalid, so a half-written slot can never produce a hit.
     *
     *  COUNTERS are always on. They live on stageData (an object already in
     *  the register set) and cost one increment against ~50 cycles of
     *  per-stage work on this path — unmeasurable here. They must NOT be tied
     *  to pipelineDebug: debug and the cache are mutually exclusive by branch
     *  order, so requiring debug to read them would always report zero hits.
     *  If this ever moves to the image kernels, select a counting variant at
     *  build time instead — there the increment is not free.
     * ============================================================================
     */
    var cacheStages = {

        /**
         * Single-entry check — memoises only the immediately preceding colour.
         * Catches solid fills and repeated runs; an alternating A-B-A-B
         * sequence never hits.
         *
         * @param {number[]} colour     the colour at the cache boundary
         * @param {object}   stageData  see buildPixelCacheStageData()
         * @param {object}   stage      own stage object — `step` is set on it
         * @returns {number[]}          cached value on a hit, else the input
         */
        stage_pixelCache_single(colour, stageData, stage){
            var channels = stageData.channels;
            var c;
            stageData.lookups++;

            if(stageData.hasPrevious && colour.length === channels){
                var previousKey = stageData.previousKey;
                var isSame = true;
                for(c = 0; c < channels; c++){
                    // Exact compare. NaN never equals itself, so a NaN input
                    // can never produce a false hit — fail-safe by construction.
                    if(previousKey[c] !== colour[c]){ isSame = false; break; }
                }
                if(isSame){
                    stageData.hits++;
                    stage.step = stageData.endStep;
                    return stageData.copyOnHit
                        ? stageData.previousValue.slice()
                        : stageData.previousValue;
                }
            }

            // Miss — record the key, invalidate the entry until STORE completes.
            if(colour.length === channels){
                var keyStore = stageData.previousKey;
                for(c = 0; c < channels; c++){ keyStore[c] = colour[c]; }
            }
            stageData.hasPrevious = false;
            stage.step = 1;
            return colour;
        },

        /**
         * Keyed check — direct-mapped table of stageData.slots entries. Also
         * catches repeating palettes and dithered patterns, which defeat the
         * single-entry form.
         *
         * The bucket index is allowed to be lossy (the colour is quantised to
         * build it); only the key stored IN the slot is compared exactly, so a
         * collision costs a miss and never a wrong answer.
         */
        stage_pixelCache_keyed(colour, stageData, stage){
            var channels = stageData.channels;
            var c;
            stageData.lookups++;

            if(colour.length !== channels){
                stage.step = 1;
                return colour;
            }

            var hash = 0;
            for(c = 0; c < channels; c++){
                hashScratchFloat[0] = colour[c];
                // Fold both halves of the double, then multiply — progressive
                // rather than a plain xor accumulate, so channel order matters
                // and a single differing channel changes the whole hash.
                hash = Math.imul(hash ^ (hashScratchBits[0] ^ hashScratchBits[1]), HASH_PRIME) | 0;
            }
            var slot = hash >>> (32 - stageData.slotBits);
            var slotBase = slot * channels;
            var keys = stageData.keys;

            if(stageData.slotValid[slot] === 1){
                var isSame = true;
                for(c = 0; c < channels; c++){
                    if(keys[slotBase + c] !== colour[c]){ isSame = false; break; }
                }
                if(isSame){
                    stageData.hits++;
                    stage.step = stageData.endStep;
                    var cachedValue = stageData.values[slot];
                    return stageData.copyOnHit ? cachedValue.slice() : cachedValue;
                }
            }

            // Miss — claim the slot, invalidate it until STORE completes.
            for(c = 0; c < channels; c++){ keys[slotBase + c] = colour[c]; }
            stageData.slotValid[slot] = 0;
            stageData.pendingSlot = slot;
            stage.step = 1;
            return colour;
        },

        /**
         * Keyed check, integer variant — used when the value at the cache
         * boundary is integral (raw int8/int16 pixel data, before the
         * conversion to 0..1). Hashes the value directly: one `imul` per
         * channel with no bit round-trip.
         *
         * Selected at build time so no test happens per colour. Which variant
         * is right cannot be read off `dataFormat` — the boundary lands on raw
         * ints for an sRGB input profile but on floats for a Lab one, at the
         * same dataFormat — so it is detected from the probe colour instead.
         *
         * Getting that detection wrong is harmless: the hash only chooses a
         * bucket, and the key stored in the slot is still compared exactly. A
         * float reaching this variant is truncated by imul's ToInt32, which
         * costs a collision (a miss), never a wrong answer.
         */
        stage_pixelCache_keyedInt(colour, stageData, stage){
            var channels = stageData.channels;
            var c;
            stageData.lookups++;

            if(colour.length !== channels){
                stage.step = 1;
                return colour;
            }

            var hash = 0;
            for(c = 0; c < channels; c++){
                hash = Math.imul(hash ^ colour[c], HASH_PRIME) | 0;
            }
            var slot = hash >>> (32 - stageData.slotBits);
            var slotBase = slot * channels;
            var keys = stageData.keys;

            if(stageData.slotValid[slot] === 1){
                var isSame = true;
                for(c = 0; c < channels; c++){
                    if(keys[slotBase + c] !== colour[c]){ isSame = false; break; }
                }
                if(isSame){
                    stageData.hits++;
                    stage.step = stageData.endStep;
                    var cachedValue = stageData.values[slot];
                    return stageData.copyOnHit ? cachedValue.slice() : cachedValue;
                }
            }

            for(c = 0; c < channels; c++){ keys[slotBase + c] = colour[c]; }
            stageData.slotValid[slot] = 0;
            stageData.pendingSlot = slot;
            stage.step = 1;
            return colour;
        },

        /**
         * Store stage — captures the finished value. Only reached on a miss,
         * because a hit jumps over it. Pass-through: returns its input
         * unchanged so the output conversion sees exactly what it otherwise
         * would.
         */
        stage_pixelCacheStore(colour, stageData, stage){
            var cacheData = stageData.cacheData;
            var channels = colour.length;
            var target;
            var c;

            if(cacheData.slots === 0){
                target = cacheData.previousValue;
                if(target === null || target.length !== channels){
                    target = cacheData.previousValue = new Array(channels);
                }
                for(c = 0; c < channels; c++){ target[c] = colour[c]; }
                cacheData.hasPrevious = true;
            } else {
                var slot = cacheData.pendingSlot;
                target = cacheData.values[slot];
                // Reuse the slot's array rather than slice()ing a new one.
                // A miss happens on the majority of pixels for photographic
                // content, so an allocation here lands on the hot path; the
                // reuse is safe because a hit returns the array to the output
                // converter, which reads it immediately and builds its own
                // result before any later miss can overwrite the slot.
                if(target === undefined || target.length !== channels){
                    target = cacheData.values[slot] = new Array(channels);
                }
                for(c = 0; c < channels; c++){ target[c] = colour[c]; }
                cacheData.slotValid[slot] = 1;
            }
            stage.step = 1;
            return colour;
        },

        /**
         * Step-aware pipeline walk for one colour.
         *
         * transformArray() has several inline per-pixel walks that increment
         * blindly; those would run the maths again on a value the cache had
         * already resolved, producing wrong output. They call this instead
         * when a cache is active. Deliberately parallel to the arm inside
         * transform(), which stays inlined because the single-colour path is
         * the one the cache exists to speed up.
         *
         * @param {*} result  the incoming colour
         * @returns {*}       the pipeline output
         */
        _walkPipelineCached(result){
            var pipeline = this.pipeline;
            var length = pipeline.length;
            var stage;
            var i = 0;
            while(i < length){
                stage = pipeline[i];
                result = stage.funct.call(this, result, stage.stageData, stage);
                i += stage.step;
            }
            return result;
        },

        /**
         * transformArray() for a cache-enabled transform.
         *
         * Correctness-first and deliberately generic: one channel loop rather
         * than transformArray()'s per-channel-count unrolling. It exists so
         * those unrolled loops stay byte-for-byte as they were — putting a
         * `cache active?` test inside them measured ~2.5% on the uncached
         * accuracy path, and a feature that is switched off must cost nothing.
         *
         * Per-pixel work is delegated to transform(), so the cache semantics
         * live in exactly one place.
         *
         * @returns {Array|Uint8ClampedArray|Uint16Array|Float32Array|Float64Array}
         */
        _transformArrayCached(inputArray, inputHasAlpha, outputHasAlpha, preserveAlpha, pixelCount, outputFormat){
            var inputChannels = this.inputChannels;
            var outputChannels = this.outputChannels;
            var inputItemsPerPixel = inputHasAlpha ? inputChannels + 1 : inputChannels;
            var outputItemsPerPixel = preserveAlpha ? outputChannels + 1 : outputChannels;
            var inputPos = 0;
            var outputPos = 0;
            var outputArray;
            var result;
            var pixel;
            var i, c;

            if(this.dataFormat === 'object' || this.dataFormat === 'objectFloat'){
                if(pixelCount === undefined){ pixelCount = inputArray.length; }
                outputArray = new Array(pixelCount);
                for(i = 0; i < pixelCount; i++){
                    outputArray[i] = this.transform(inputArray[i]);
                }
                return outputArray;
            }

            if(pixelCount === undefined){
                pixelCount = Math.floor(inputArray.length / inputItemsPerPixel);
            }

            var outputLength = pixelCount * outputItemsPerPixel;
            switch(outputFormat){
                case 'int8':    outputArray = new Uint8ClampedArray(outputLength); break;
                case 'int16':   outputArray = new Uint16Array(outputLength);       break;
                case 'float32': outputArray = new Float32Array(outputLength);      break;
                case 'float64': outputArray = new Float64Array(outputLength);      break;
                case 'same':
                    switch(inputArray.constructor.name){
                        case 'Uint8Array':   outputArray = new Uint8ClampedArray(outputLength); break;
                        case 'Uint16Array':  outputArray = new Uint16Array(outputLength);       break;
                        case 'Float32Array': outputArray = new Float32Array(outputLength);      break;
                        case 'Float64Array': outputArray = new Float64Array(outputLength);      break;
                        default: throw 'Unknown inputArray type ' + inputArray.constructor.name;
                    }
                    break;
                default: outputArray = new Array(outputLength);
            }

            for(i = 0; i < pixelCount; i++){
                pixel = new Array(inputChannels);
                for(c = 0; c < inputChannels; c++){ pixel[c] = inputArray[inputPos++]; }

                result = this.transform(pixel);

                for(c = 0; c < outputChannels; c++){ outputArray[outputPos++] = result[c]; }

                if(preserveAlpha){
                    outputArray[outputPos++] = inputArray[inputPos++];
                } else {
                    if(inputHasAlpha){ inputPos++; }
                    if(outputHasAlpha){ outputArray[outputPos++] = 255; }
                }
            }

            return outputArray;
        },

        /**
         * Inject the pixel-cache stages into an already-built pipeline.
         *
         * MUST be called after optimisePipeline() — so the optimiser cannot
         * fold the cache stages into a neighbour, and so the positions
         * resolved here are final — and before verifyPipeline(), so the
         * injected stages' encodings are still checked rather than trusted.
         *
         * Declines (leaving a working, uncached pipeline) whenever the shape
         * is not one the cache can safely handle.
         *
         * @returns {boolean} true if the stages were injected
         */
        injectPixelCacheStages(){
            var pipeline = this.pipeline;
            var length = pipeline.length;
            var requestedSlots = this.pixelCache;
            var i;

            if(!requestedSlots || length === 0){ return false; }

            // Debug records pipelineHistory per stage; a jump would fabricate a
            // history that never ran. Mutually exclusive by branch order in
            // transform() as well — this just makes the intent explicit.
            if(this.pipelineDebug){
                console.warn('jsColorEngine: pixelCache disabled while pipelineDebug is on');
                return false;
            }

            // A custom stage before the output conversion is folded into the
            // cached value, which is correct — but a side-effecting one
            // (logging, accumulating statistics) would be skipped on hits.
            if(this.customStages && this.customStages.length > 0){
                console.warn('jsColorEngine: pixelCache disabled — custom stages may have side effects that cache hits would skip');
                return false;
            }

            // STORE goes immediately before the output conversion, resolved by
            // identity (see the marker note in createPipeline). No output
            // conversion — dataFormat 'device' — means it goes at the end.
            var storeAt = length;
            if(this._pcOutputFirst){
                storeAt = pipeline.indexOf(this._pcOutputFirst);
                if(storeAt === -1){
                    console.warn('jsColorEngine: pixelCache disabled — output boundary was replaced by the optimiser');
                    return false;
                }
            }

            var channels = this.inputChannels;
            if(!channels || channels < 1){
                console.warn('jsColorEngine: pixelCache disabled — input channel count unknown');
                return false;
            }

            // CHECK goes at the EARLIEST position where the colour has become a
            // plain numeric array — the earlier the check, the more work a hit
            // skips. That position is found empirically by walking one probe
            // colour through, because neither stage positions nor encodings can
            // tell us:
            //
            //   - Positions: the optimiser fuses across the input-conversion
            //     boundary (LabD50_to_PCSv4 + PCSv4_to_PCSXYZ collapse), so the
            //     value that boundary referred to stops materialising at all.
            //   - Encodings: the enum cannot distinguish object-shaped from
            //     array-shaped values. stage_cmsLab_to_LabD50 emits an OBJECT
            //     tagged encoding 3, and encoding 3 is ALSO PCSXYZ, an array.
            //
            // Running a probe colour through at build time is the same
            // technique validatePipeline() already uses, and costs one walk.
            var probeColour = this._buildValidationInput(this.dataFormat);
            if(probeColour === null){
                console.warn('jsColorEngine: pixelCache disabled — could not build a probe colour');
                return false;
            }

            var checkAt = -1;
            for(i = 0; i <= storeAt; i++){
                if(cacheStages.isCacheableColour(probeColour, channels)){ checkAt = i; break; }
                if(i >= length){ break; }
                try {
                    probeColour = pipeline[i].funct.call(this, probeColour,
                        pipeline[i].stageData, pipeline[i]);
                } catch(probeError){
                    break;
                }
            }

            if(checkAt === -1 || checkAt > storeAt){
                console.warn('jsColorEngine: pixelCache disabled — no numeric-array position found before the output conversion');
                return false;
            }

            // When nothing runs after STORE there is no output conversion to
            // rebuild a fresh result, so what CHECK returns IS the caller's
            // value and must be a copy they can safely mutate.
            var copyOnHit = (storeAt >= length);

            var cacheData = cacheStages.buildPixelCacheStageData(requestedSlots, channels, copyOnHit);
            var isSingleEntry = (cacheData.slots === 0);

            // Pick the hash variant from the probe colour rather than from
            // dataFormat — see stage_pixelCache_keyedInt for why dataFormat
            // cannot decide, and why a wrong guess is harmless.
            var isIntegerBoundary = true;
            for(i = 0; i < channels; i++){
                if(!Number.isInteger(probeColour[i])){ isIntegerBoundary = false; break; }
            }

            var checkFunction, checkName;
            if(isSingleEntry){
                checkFunction = this.stage_pixelCache_single;
                checkName = 'stage_pixelCache_single';
            } else if(isIntegerBoundary){
                checkFunction = this.stage_pixelCache_keyedInt;
                checkName = 'stage_pixelCache_keyedInt';
            } else {
                checkFunction = this.stage_pixelCache_keyed;
                checkName = 'stage_pixelCache_keyed';
            }

            // endStep lands the walk on the output conversion (or past the end
            // of the pipeline), having skipped the maths AND the store stage.
            // Both insertions shift it, hence +2. Computed once — everything it
            // depends on is fixed by this point.
            cacheData.endStep = (storeAt + 2) - checkAt;

            // Encodings in force at each insertion point. The injected stages
            // are pass-throughs, so input and output encoding are the same.
            // Not hardcoded to `device`: see the header note.
            var encodingAtCheck = (checkAt === 0)
                ? pipeline[0].inputEncoding : pipeline[checkAt - 1].outputEncoding;
            var encodingAtStore = (storeAt === 0)
                ? pipeline[0].inputEncoding : pipeline[storeAt - 1].outputEncoding;

            var checkStage = this.createStage(
                encodingAtCheck,
                checkName,
                checkFunction,
                cacheData,
                encodingAtCheck,
                '  [PixelCache check]|({last}) > ({data})'
            );

            var storeStage = this.createStage(
                encodingAtStore,
                'stage_pixelCacheStore',
                this.stage_pixelCacheStore,
                {cacheData: cacheData},
                encodingAtStore,
                '  [PixelCache store]|({last}) > ({data})'
            );

            // Insert the later position first so the earlier one stays valid.
            pipeline.splice(storeAt, 0, storeStage);
            pipeline.splice(checkAt, 0, checkStage);

            // The cache walk reads stage.step rather than incrementing, so
            // every stage needs one. Set here rather than in createStage so the
            // object shape on the default (uncached) path is untouched.
            for(i = 0; i < pipeline.length; i++){
                pipeline[i].step = 1;
            }

            this._pixelCacheData = cacheData;
            return true;
        },

        /**
         * True when a value can serve as a cache key: a plain numeric array
         * (or typed array) of exactly the expected length. Objects such as
         * {L, a, b} have no `length` and are correctly rejected.
         *
         * @param {*}      value
         * @param {number} channels  expected component count
         * @returns {boolean}
         */
        isCacheableColour(value, channels){
            if(value === null || typeof value !== 'object'){ return false; }
            if(value.length !== channels){ return false; }
            for(var c = 0; c < channels; c++){
                if(typeof value[c] !== 'number'){ return false; }
            }
            return true;
        },

        /**
         * Allocate the cache tables.
         *
         * @param {number}  requestedSlots  1 for the single-entry form, else
         *                                  rounded down to a power of two
         * @param {number}  channels        numeric components per colour
         * @param {boolean} copyOnHit       true when no stage runs after the
         *                                  cache, so the caller receives the
         *                                  cached array itself unless copied
         */
        buildPixelCacheStageData(requestedSlots, channels, copyOnHit){
            var slotBits = 0;
            var remaining = requestedSlots;
            while(remaining > 1){ remaining >>= 1; slotBits++; }

            var stageData = {
                channels: channels,
                copyOnHit: copyOnHit === true,
                endStep: 1,
                // 0 marks the single-entry form; anything else is a power of two
                slots: (requestedSlots <= 1) ? 0 : (1 << slotBits),
                slotBits: slotBits,
                hits: 0,
                lookups: 0,
                // single-entry state
                previousKey: new Float64Array(channels),
                previousValue: null,
                hasPrevious: false,
                // keyed-table state
                keys: null,
                values: null,
                slotValid: null,
                pendingSlot: 0
            };

            if(stageData.slots > 0){
                stageData.keys      = new Float64Array(stageData.slots * channels);
                stageData.values    = new Array(stageData.slots);
                stageData.slotValid = new Uint8Array(stageData.slots);
            }

            return stageData;
        },

        /**
         * Pixel-cache counters for this transform.
         *
         * Hit rate is the number this instrumentation exists for: it is a
         * property of the DATA, not of the implementation, so it transfers to
         * the question of whether a cache is worth adding to the image
         * kernels. Timings from this path do NOT transfer — register pressure
         * and branch misprediction dominate there and are near-free here.
         *
         * @returns {{enabled: boolean, slots: number, hits: number,
         *           misses: number, lookups: number, hitRate: number}}
         */
        getPixelCacheStats(){
            var stageData = this._pixelCacheData;
            if(!stageData){
                return {enabled: false, slots: 0, hits: 0, misses: 0, lookups: 0, hitRate: 0};
            }
            return {
                enabled: true,
                slots: (stageData.slots === 0) ? 1 : stageData.slots,
                hits: stageData.hits,
                misses: stageData.lookups - stageData.hits,
                lookups: stageData.lookups,
                hitRate: (stageData.lookups === 0) ? 0 : stageData.hits / stageData.lookups
            };
        },

        /**
         * Zero the counters without discarding cached entries. Use between
         * corpus images so per-image hit rates stay separable.
         */
        resetPixelCacheStats(){
            if(this._pixelCacheData){
                this._pixelCacheData.hits = 0;
                this._pixelCacheData.lookups = 0;
            }
        },

        /**
         * Drop every cached entry, leaving the counters alone. For tests that
         * want a cold cache without rebuilding the transform.
         */
        clearPixelCache(){
            var stageData = this._pixelCacheData;
            if(!stageData){ return; }
            stageData.hasPrevious = false;
            stageData.previousValue = null;
            if(stageData.slots > 0){
                stageData.slotValid = new Uint8Array(stageData.slots);
                stageData.values = new Array(stageData.slots);
            }
        }
    };

    module.exports = cacheStages;
