// src/kernels/strategyHost.js
//
// Every dimensional kernel can host STRATEGIES: alternative kernels offered to
// it after the pipeline is built, chosen on the SHAPE the optimiser folded the
// conversion into rather than on channel count.
//
// The matrix shaper is the one that ships. `*sRGB -> *AdobeRGB` folds to a
// curve, a 3x3 and another curve; `*sRGB -> GRACoL` does not; `*sRGB -> *sRGB`
// with identity detection on collapses to a copy with nothing left to
// accelerate. No channel count separates those three -- only the built
// pipeline does, which is why this is asked at init() and not at setKernel().
//
// WHY EVERY DIMENSION GETS ONE. It would be easy to give this only to Kernel3D,
// since that is where the only shipped strategy lives. But then a CMYK fast
// path would have nowhere to register, and Transform.registerKernel would fail
// on a descriptor that looks perfectly valid. A dimension that has no
// strategies simply has an empty list and init() returns the pipeline
// unchanged -- which costs one function call per create().
'use strict';

/**
 * Build a strategy registry plus the init() that consults it. Each kernel gets
 * its own list; nothing is shared between dimensions.
 *
 * @returns {{strategies: Array, registerStrategy: Function, init: Function}}
 */
function makeStrategyHost(){
    var strategies = [];

    return {
        strategies: strategies,

        /**
         * Registering the same name again replaces in place, so ordering stays
         * stable rather than gaining a second copy that is never reached.
         */
        registerStrategy: function(descriptor){
            for(var i = 0; i < strategies.length; i++){
                if(strategies[i].name === descriptor.name){
                    strategies[i] = descriptor;
                    return;
                }
            }
            strategies.push(descriptor);
        },

        /**
         * Offer the pipeline to each strategy in registration order; the first
         * that claims it takes the batch path.
         *
         * Called once per create(), after optimisePipeline() and after
         * pipelineCreated -- so the LUT scales are final and the pipeline is
         * the one that will actually run.
         *
         * A STRATEGY THAT THROWS IS A DECLINE. These are registered
         * third-party code running inside create(), and declining is always an
         * available answer, so an exception must not take the Transform down.
         *
         * @param {Array}  pipeline
         * @param {object} opts   see Transform._kernelOpts()
         * @returns {{pipeline:Array, kernel:?object, claim:?object}}
         */
        init: function(pipeline, opts){
            for(var i = 0; i < strategies.length; i++){
                var descriptor = strategies[i];
                var verdict;
                try {
                    verdict = descriptor.claims(pipeline, opts);
                } catch(e){
                    continue;
                }
                if(!verdict || verdict.ok !== true) continue;

                var instance = Object.create(descriptor);
                instance.transform = opts.transform;
                instance.claimed   = true;
                instance._impl     = undefined;
                instance._variant  = null;
                return {
                    pipeline: pipeline,
                    kernel:   instance,
                    claim:    { name: descriptor.name, why: verdict.why || null }
                };
            }
            return { pipeline: pipeline, kernel: null, claim: null };
        },
    };
}

module.exports = { makeStrategyHost: makeStrategyHost };
