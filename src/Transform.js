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
     *
     *
     *  customStages
     *  - This is an array of custom stages to be added to the pipeline
     *      - Each stage is an object with the following properties
     *      {
     *          description: 'name of stage',
     *          stageData: {object to be passed to the stage function},
     *          stageFn: function(input, stageData, stage){ return output; },
     *          location:  'beforeInput2Device',  'beforeDevice2PCS', 'afterDevice2PCS', 'PCS', 'beforePCS2Device', 'afterPCS2Device', 'afterDevice2Output',
     *                      For multi-stage profiles, these will be inserted at each stage, if you need to target a specific stage, use the location
     *                      'beforeDevice2PCS(n)', 'afterDevice2PCS(n)', 'PCS(n)', 'beforePCS2Device(n)', 'afterPCS2Device(n)', when n is the stage number, starting at 0
     *      }
     *
     *
     *
     *  Note to about optimisation      - Building the pipeline is done once so it does not matter if slow or not optimised
     *                                  - The pipeline itself can be optimised to remove un-necessary conversions, so wont
     *                                    get too hung up about checking for optimisation when building the pipeline
     *                                  - The stages themselves are called many times so they need to be optimised
     *                                  - One future idea is for the stages to return code as a string, which can be
     *                                    compiled into a function, this would be faster than calling a function.
     *
     * Dataformat options
     *   object        A structured format {type: eColourType, R:0, G:0, B:0} or {type: eColourType, L:0, a:0, b:0} etc,
     *                  compatible with the convert functions, useful for easier handling of data and analysis of data
     *
     *   objectFloat    Same as object but with floats instead of integers
     *                  RGB is 0.0 - 1.0 {type: eColourType, Rf:0.0, Gf:0.0, Bf:0.0}
     *                  Lab is 0.0 - 1.0 {type: eColourType, L:0.0, a:0.0, b:0.0} (Same as usual)
     *                  CMYK is 0.0 - 1.0 {type: eColourType, Cf:0.0, Mf:0.0, Yf:0.0, Kf:0.0}
     *
     *   int8           8bit integer array, 0-255
     *
     *   int16          16bit integer array, 0-65535
     *
     *   device         An array of n-Channel floats with a range of 0.0 to 1.0 i.e [0.0, 0.0, 0.0] or [0.0, 0.0, 0.0, 0.0]
     *                  CMYK 25%,0,100%,50% would be [0.25, 0.0, 1.0, 0.5]
     *                  RGB 255,0,25 would be [1.0, 0.0, 0.098..]
     *
     *  @param options
     *  @param {boolean} options.builtLut           - precompute and store the LUT for faster conversion at the cost of accuracy
     *  @param {!number} options.lutGridPoints3D    - number of grid points to use when creating the LUT, typically 17, 33 or 65,
     *                                                anything more gets diminishing returns
     *  @param {!number} options.lutGridPoints4D    - number of grid points to use when creating the LUT, typically 11, 17, 33,
     *                                                anything more gets diminishing returns
     *  @param {string} options.LUTinterpolation    - 'trilinear' or 'tetrahedral' interpolation for the pipeline for LUTs
     *
     *  @param {string} options.interpolation       - 'trilinear' or 'tetrahedral' interpolation for the 3D/4D pipeline
     *                                                 NOTE!! tetrahedral is faster and more accurate than trilinear!!!
     *  @param {string} options.dataFormat          - either 'object', 'objectFloat', 'int8', 'int16', 'device', see above
     *  @param {boolean} options.useFloats          - Obsolete, use dataFormat instead
     *  @param {boolean} options.labAdaptation      - If true >object based Lab< is adapted to D50 white point before conversion, i.e LabD65 will be converted to LabD50 before transforms
     *  @param {boolean} options.displayChromaticAdaptation - If true, chromatic adaptation across the PCS if the profiles have different whitepoints
     *  @param {boolean} options.pipelineDebug      - If true, the pipeline is debugged and the debug history can be retrieved
     *  @param {boolean} options.optimise           - If true, the pipeline is optimised to remove un-necessary conversions
     *  @param {boolean} options.roundOutput        - If true, the output is rounded to the decimal places specified in precession,
     *                                                otherwise the output is raw which can be long numbers such as 243.201001983...
     *  @param {number} options.precession          - Number of decimal places to round to, default is 0
     *  @param {[boolean] || boolean} options.BPC   - If true, Black Point Compensation is applied
     *                                                Can also be an array of booleans to specify which STAGE to use,i.e 0,1,2, not 1,3,5
     *
     *   * @constructor
     */
     class Transform{
        constructor(options){

        options = options || {};

        this.builtLut = options.builtLut === true;
        this.lutGridPoints3D = (isNaN(Number(options.lutGridPoints3D))) ? 33 : Number(options.lutGridPoints3D);
        this.lutGridPoints4D = (isNaN(Number(options.lutGridPoints4D))) ? 17 : Number(options.lutGridPoints4D);

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
            case 'device':
                convertInputOutput = false;
                break;
            default:
                throw 'Invalid dataFormat "' + this.dataFormat + '". Must be "object", "objectFloat", "int8", "int16" or "device"';
        }

        this.convertInputOutput = convertInputOutput;
        this.verbose = options.verbose === true;
        this.pipelineDebug = options.pipelineDebug === true;
        this.optimise = options.optimise !== false;
        this.optimiseDebug = [];
        this.roundOutput = options.roundOutput !== false;
        this.precession = (isNaN(Number(options.precession))) ? 0 : Number(options.precession);

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
     * Get the prebuilt lut - which can be used in future instead of using profiles
     * @param precession
     * @returns {any}
     */
    getLut(precession){
        var CLUT
        if(precession === undefined || precession === false) {
            CLUT = this.lut.CLUT;
        } else {
            // round, which will make output smaller when saved to JSON
            var p = Math.pow(10, precession)
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
     * This is the main function for creating a transform from two profiles, It will build
     * a pipeline of stages to convert from one profile to another, and then optimise the pipeline
     * @param {string|Profile}inputProfile
     * @param {string|Profile} outputProfile
     * @param {eIntent} intent
     * @param {[]} customStages
     */

    create(inputProfile, outputProfile, intent, customStages) {
        return this.createMultiStage([inputProfile, intent, outputProfile] ,customStages)
    }


    /**
     * This is the main function for creating a transform from two OR MORE profiles, It will build the entire pipeline
     *
     * For exmaple if you want to create a proofing profile to simlulate CMYK printing, you would pass in the following
     * profiles in order
     *   profileChain = [
     *      profile,
     *      intent,
     *      profile,
     *      intent,
     *      profile
     *      ]
     *
     *       {inputProfile: '*sRGB', outputProfile: CMYKProfile, intent: eIntent.perceptual, customStages: []},
     *       {inputProfile: CMYKProfile, outputProfile: '*sRGB', intent: eIntent.relative},
     *   ]
     *
     *  If you wanted to know if a lab value is converted to RGB, printed in CMYK what is the final lab value
     *  to calcualte a DeltaE

     *  profileChain = [ '*lab', eIntent.relative,  '*sRGB']
     *  profileChain = [ '*sRGB', eIntent.perceptual,CMYKProfile ],
     *  profileChain = [CMYKProfile, outputProfile: '*lab', intent: eIntent.absolute},
     *
     * @param {[]} profileChain
     * @param {[]} customStages
     */
    createMultiStage(profileChain, customStages) {
        customStages = customStages || [];
        var step, i;
        var chainEnd = profileChain.length - 1;

        // Create Virtual profiles
        // This makes it easier to just create a transform from a profile name
        // and not have to worry about loading the profile
        for( i = 0; i < profileChain.length; i++) {
            step = profileChain[i];
            if (typeof step === 'string') {
                if (step.substring(0, 1) === '*') {
                    // automatically create virtual profile
                    profileChain[i] = new Profile(step);
                } else {
                    throw 'Invalid inputProfile ' + i + ' is a string not a Profile';
                }
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
                throw 'Invalid profileChain, must have at least items';
            }

            for(i = 0; i < profileChain.length; i++){
                step = profileChain[i];

                if(i % 2 === 0){
                    // profile
                    if(!step instanceof Profile){
                        throw 'step  ' + i + ' in chain is not a Profile';
                    }

                    if(!step.loaded){
                        throw 'Profile  ' + i + ' in chain is not loaded';
                    }
                } else {
                    // intent
                    if(typeof step !== 'number'){
                        throw 'step  ' + i + ' in chain is not an intent';
                    }

                    if(!(step === eIntent.absolute ||
                         step === eIntent.perceptual ||
                         step === eIntent.relative ||
                         step === eIntent.saturation
                    )){
                        throw 'step  ' + i + ' in chain is not a valid intent';
                    }
                }
            }

            if(!profileChain[0] instanceof Profile){
                throw 'First step in chain is not a Profile';
            }

            if(!profileChain[chainEnd] instanceof Profile){
                throw 'Last step in chain is not a Profile';
            }

        } else {
            if(this.lut.CLUT === undefined || this.lut.CLUT === null){
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
        console.time('create Prebuilt Lut');
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
                throw 'Create Lut  Invalid output profile type ' + this.outputProfile.type;
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
                throw 'Create Lut  Invalid input profile type ' + this.inputProfile.type;
        }

        console.timeEnd('create Prebuilt Lut');

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
            encoding: 'number', // number or base64
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
     * Converts colours using the pipeline
     * Note: Called Forward and there was a plan to build the reverse pipeline automatically, but this is not currently supported
     * @param cmsColor
     * @returns {*}
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
     * Converts colours using the pipeline
     * @param cmsColor
     * @returns {*}
     */
    transform(cmsColor){
        return this.forward(cmsColor);
    }

    /**
     * An optimised fast transformer for converting 8bit imag data
     * Picks to fastest method based on input and output profiles
     *
     * TODO : Set input and output formats RGB, RGBA, CMYK, CMYKA, BGRA
     *
     * @param inputArray
     * @param inputHasAlpha
     * @param outputHasAlpha
     * @param preserveAlpha - If true, the alpha channel is preserved, otherwise it is discarded,
     *                        If not spefified, it is set to true if outputHasAlpha and inputHasAlpha true
     * @param pixelCount - Number of pixels to convert, if not specified, it is calculated from inputArray length
     */
    transformArrayViaLUT(inputArray, inputHasAlpha, outputHasAlpha, preserveAlpha, pixelCount){
        var lut = this.lut;
        if(!lut){
            throw 'No LUT loaded';
        }

        preserveAlpha = preserveAlpha || outputHasAlpha && inputHasAlpha;
        var inputBytesPerPixel = (inputHasAlpha) ? lut.inputChannels + 1 : lut.inputChannels;
        var outputBytesPerPixel = (outputHasAlpha) ? lut.outputChannels + 1 : lut.outputChannels;
        if(pixelCount === undefined){
            pixelCount = Math.floor(inputArray.length / inputBytesPerPixel);
        }
        var outputArray = new Uint8ClampedArray(pixelCount * outputBytesPerPixel);
        var inputChannels = lut.inputChannels;
        var outputChannels = lut.outputChannels;

        switch(inputChannels){
            case 1: // Gray / mono
                this.linearInterp1DArray_NCh_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha)
                break;

            case 2: // Duo tones
                this.bilinearInterp2DArray_NCh_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha)
                break;

            case 3: // RGB or Lab
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
     * Converts colours using the pipeline in an array
     * TODO add a pixelFormat RGBA, RGB, CMYK, CMYKA, BGRA
     * @param inputArray
     * @param inputHasAlpha
     * @param outputHasAlpha
     * @param preserveAlpha
     * @param pixelCount
     * @param outputFormat
     * @returns {any[]}
     */
    transformArray(inputArray, inputHasAlpha, outputHasAlpha, preserveAlpha, pixelCount, outputFormat){

        if(!this.pipelineCreated){
            throw 'No Pipeline';
        }

        if(this.dataFormat === 'object' || this.dataFormat === 'objectFloat'){
            throw 'forwardArray can only be used with int8 or int16 dataFormat';
        }

        if(preserveAlpha && !inputHasAlpha){
            throw 'preserveAlpha is true but inputArray has no alpha channel';
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

            if(!lutInputProfile instanceof Profile){
                throw 'LUT Chain does not start with a profile';
            }

            if(!lutOutputProfile instanceof Profile){
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
            var intSize = this.dataFormat === 'int8' ? 255 : 65535;
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
                            this.precession,
                            encoding.cmsRGB,
                            '  [Device2Output : Gray : {name}]| ({last}) > {data}'
                        );
                        break;
                    case 'objectFloat':
                        this.addStage(
                            encoding.device,
                            'stage_device_to_Grayf',
                             this.stage_device_to_Grayf,
                            this.precession,
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
                            this.precession,
                            encoding.cmsRGB,
                            '  [Device2Output : Duo : {name}]| ({last}) > {data}'
                        );
                        break;
                    case 'objectFloat':
                        this.addStage(
                            encoding.device,
                             'stage_device_to_Duof',
                            this.stage_device_to_Duof,
                            this.precession,
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
                            this.precession,
                            encoding.cmsRGB,
                            '  [Device2Output : RGB : {name}]| ({last}) > {data}'
                        );
                        break;
                    case 'objectFloat':
                        this.addStage(
                            encoding.device,
                            'stage_device_to_RGBf',
                            this.stage_device_to_RGBf,
                            this.precession,
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
                            this.precession,
                            encoding.cmsCMYK,
                            '  [Device2Output : CMYK : {name}]| ({last}) > {data}'
                        );
                        break;
                    case 'objectFloat':
                        this.addStage(
                            encoding.device,
                            'stage_device_to_CMYKf',
                            this.stage_device_to_CMYKf,
                            this.precession,
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
     *
     * So, shocker, Javascript can be slow sometimes, so here rather than using a generic function to do the interpolation
     * we select a specific function for each type of interpolation. This is because the generic function are about 10-20x slower
     *
     * We optimise for the 3D to 3ch or 4ch which is RGB>RGB or RGB>CMYk and also 4D to 3ch or 4ch which is CMYk>RGB or CMYk>CMYk
     * Since Gray and Duo tone are not common we don't optimise for them
     *
     * Note, further down we also have optimised versions of the 3D and 4D interpolation functions for arrays, these are used
     * with prebuilt LUTS, however I noticed that if we used them here to save code, it would poison the JIT compiler and
     * make the array functions 2-3x slower as they were de-optimised, So keeping them separate means that the arrays
     * interpolation functions will be JIT optimised for clamped arrays and the pipeline functions below are optimised
     * for float arrays
     *
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

    pushStage(stage){
        this.pipeline.push(stage);
    };

    addStage(inputEncoding, stageName, funct, stageData, outputEncoding, debugFormat){
        this.pushStage(this.createStage(inputEncoding, stageName, funct, stageData, outputEncoding, debugFormat, false));
    };

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

    stage_device_to_Gray_round(device, precession){
        return {
            G: roundN(device[0] * 255, precession),
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

    stage_device_to_Duo_round(device, precession){
        return {
            a: roundN(device[0] * 100, precession),
            b: roundN(device[1] * 100, precession),
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

    stage_device_to_RGB_round(device, precession){
        return {
            R: roundN(device[0] * 255, precession),
            G: roundN(device[1] * 255, precession),
            B: roundN(device[2] * 255, precession),
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

    stage_device_to_CMYK_round(device, precession){
        return { //  * 0.0015259021896696422
            C: roundN(device[0] * 100, precession),
            M: roundN(device[1] * 100, precession),
            Y: roundN(device[2] * 100, precession),
            K: roundN(device[3] * 100, precession),
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






/**
 * 3D Trilinear interpolation - Slow - Tetrahedral is better EXCEPT PVC>Device
 *
 * With device LUT's White is one corner and black is the opposite corner, so the
 * data is encoded diagonally across the cube. This means that the tetrahedral
 * interpolation works well in this case and is faster than the trilinear.
 *
 * BUT for the PCS input, the data is encoded vertically from black to white
 * though the middle of the cube. with a/b horizontally and L vertically. This
 * means that in this special case the trilinear interpolation is more accurate.
 *
 * @param input
 * @param lut
 * @returns {[undefined,undefined,undefined,undefined]}
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
     * 3D Trilinear interpolation - Slow - Tetrahedral is better
     * @param input
     * @param lut
     * @param K0
     * @returns {[]}
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
     * 4D Trilinear interpolation - Slow - Tetrahedral is better
     * @param input
     * @param lut
     * @returns {[*,*,*,*]|*[]}
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
     * tetrahedralInterp3D_Master
     * Initalize the tetrahedral interpolation
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
     * Optimised version of tetrahedralInterp3D_Master
     * About 70% faster with functions combined
     * @param input
     * @param lut
     * @param K0
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
     * PERFORMANCE LESSIONS
     *
     *  - Remove calls, inline functions
     *  - Don't save part calculations to temp valables
     *              FASTER  a=b*c*d and e=b*c*n
     *              SLOWER  temp=b*c, a=temp*d, e=temp*n - Suspect extra time to save and load variables is slower
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
     * 3D Tetrahedral interpolation for 3D inputs and n Channels output
     * Used for PCS > 1,2 or nColour outputs
     * PCS > 3ch or PCS > 4ch have optimised versions for speed
     * @param input
     * @param lut
     * @returns {any[]}
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

    //UPDATED
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
     * Bilinear interpolation - NOT optimised for speed YET
     * @param input
     * @param inputPos
     * @param output
     * @param outputPos
     * @param length
     * @param lut
     * @param inputHasAlpha
     * @param outputHasAlpha
     * @param preserveAlpha
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

//UPDATED
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
        }

        if(preserveAlpha) {
            output[outputPos++] = input[inputPos++];
        } else {
            if(inputHasAlpha)  { inputPos++;  }
            if(outputHasAlpha) {
                    output[outputPos++] = 255;
                }
        }
    };

    //UPDATED
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

    //UPDATED
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
        var transformLab2Device = new Transform({precession: 3});
        var transformDevice2Lab = new Transform({precession: 3});

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
        var transformDevice2Lab = new Transform({precession: 3});

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

        var transformLab2Device = new Transform({precession: 3});
        var transformDevice2Lab = new Transform({precession: 3});

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


function data2String(color, format, precession){
    if(typeof precession === 'undefined'){
        precession = 6;
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
                str += n2str(color[i], precession);
        }
        if(i<color.length - 1){
            str += ', ';
        }
    }
    return str;

    function n2str(n){
        return isNaN(n) ? n : n.toFixed(precession);
    }
}


module.exports = Transform;
