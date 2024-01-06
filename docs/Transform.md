
### Notes about prebuilt LUT Size

The prebuilt LUTs are built with a grid size of 33x33x33 for 
RGB/Lab Inputs and 17x17x17x17 for CMYK inputs. Lut size increases exponentially
so 4D luts tend to be smaller

A 3D LUT 17x17x17 is 4913 entries
A 4D LUT 17x17x17x17 is 83521 entries but at 33x33x33x33 its 11881376 entries.


 

### Transform Methods

#### constructor(options)
Initializes a new Transform instance, See above for options


| Option                       | Type      | Default       | Description                                                                                                                                                              |
|------------------------------|-----------|---------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `BPC`                        | Boolean   | false         | Enables black point compensation - Note that BPC will be auto enabled for some profiles                                                                                  |
| `dataFormat`                 | String    | 'object'      | 'object', 'objectFloat', 'int8', 'int16', 'device'                                                                                                                       |
| `roundOutput`                | Boolean   | true          | Rounds the output values                                                                                                                                                 |
| `precession`                 | Number    | 0             | Number of decimals to round to                                                                                                                                           |
| `interpolation`              | Boolean   | 'tetrahedral' | 'trilinear' or 'tetrahedral'                                                                                                                                             |
| `labAdaptation`              | Boolean   | false         | If true **object based Lab** is adapted to D50 white point before conversion, i.e LabD65 will be converted to LabD50 before transforms                                   |
| `displayChromaticAdaptation` | Boolean   | false         | Perform chromatic adaptation across the PCS if the profiles have different whitepoints, False by default as according to specs profiles should already be adapted to PCS |
| `optimise`                   | Boolean   | true          | Optimise the pipeline to remove un-necessary conversions                                                                                                                 |
| `pipelineDebug`              | Boolean   | false         | Saves a history of the values at each stage in the pipeline                                                                                                              |
| `buildLUT`                   | Boolean   | false         | If true, a lookup table is built for the transform. This is faster but less accurate                                                                                     |
| `verbose`                    | Boolean   | false         | Logs into to console                                                                                                                                                     |
| `lutGridPoints3D`            | Number    | 33            | The number of grid points in each dimension for a 3D LUT. typically 17, 33 or 65, anything more gets diminishing returns                                                 |
| `lutGridPoints4D`            | Number    | 17            | The number of grid points in each dimension for a 4D LUT. typically 11, 17, 33, anything more gets diminishing returns                                                   |
| `LUTinterpolation`           | string    | 'tetrahedral' | The interpolation method used for lookup tables, trilinear' or 'tetrahedral'                                                                                             |

### create(inputProfile, outputProfile, eIntent)
* inputProfile: Instance of Profile or name of virtual profile, i.e '*lab'
* outputProfile: Instance of Profile or name of virtual profile, i.e '*srgb'
* eIntent: Rendering intent to use for the transform, i.e eIntent.perceptual
* Returns : none, Throws error if pipeline cannot be created

### createMultiStage(profileChain, customStages)
* profileChain: Array of profiles and intents in order to use in the transform, must be `[profile, eIntent, profile, eIntent, ... profile]`
* customStages: Array of custom stages to use in the transform

### transform(inputColor)
* inputColor: Color to transform, can be any of the supported color types
* Returns : Color in the output profile

### transformArray(inputArray, inputHasAlpha, outputHasAlpha, preserveAlpha, pixelCount, outputFormat)
* inputArray: Array of input colors, can be any of the supported color types
* inputHasAlpha: Boolean indicating if the input array has an alpha channel, expected to be the last channel, ignored if dataFormat is 'object' or 'objectFloat'
* outputHasAlpha: Boolean indicating if the output array should have an alpha channel, expected to be the last channel, will be set to 255 unless preserveAlpha=true ignored if dataFormat is 'object' or 'objectFloat'
* preserveAlpha: Boolean indicating if the alpha channel should be preserved, ignored if dataFormat is 'object' or 'objectFloat'
* pixelCount: Number of pixels or items to convert, if not specified the length of the input array is used
* outputFormat: String indicating the output array type, Standard array created if blank, options are 'int8' = Uint8ClampedArray(), 'int16' = Uint16Array(), 'float32' = Float32Array(), 'float64' = Float64Array(), 'same'  
* Returns : Array of colors in the output profile

### transformArrayViaLUT(inputArray, inputHasAlpha, outputHasAlpha, preserveAlpha, pixelCount)
A High speed transform using a prebuilt LUT on Uint8ClampedArrays specifically for image data, See above for LUT options
* inputArray: Array of input colors Uint8ClampedArray
* inputHasAlpha: Boolean indicating if the input array has an alpha channel, expected to be the last channel
* outputHasAlpha: Boolean indicating if the output array should have an alpha channel, expected to be the last channel, will be set to 255 unless preserveAlpha=true
* preserveAlpha: Boolean indicating if the alpha channel should be preserved
* pixelCount: Number of pixels or items to convert, if not specified the length of the input array is used


### getStageNames()
* Returns : Array of string with names of the stages the transform pipeline

### debugInfo()
* Returns : Object string with information about the transform including Chain, History and Optimise info

### chainInfo()
* Returns : Object string with information about the transform chain

### historyInfo()
* Returns : Object string with information about the transform history

### optimiseInfo()
* Returns : Object string with information about the optimisation






### Transform Properties


| Property | Description                                                                                                        |
| --- |--------------------------------------------------------------------------------------------------------------------|
| `inputProfile` | The FIRST input profile for the transformation.                                                                    |
| `outputProfile` | The LAST output profile for the transformation.                                                                    |
| `inputChannels` | The number of channels in the input profile.                                                                       |
| `outputChannels` | The number of channels in the output profile.                                                                      |
| `usesBPC` | A boolean indicating if Black Point Compensation is applied.                                                       |
| `usesAdaptation` | A boolean indicating if chromatic adaptation is applied across the PCS if the profiles have different whitepoints. |
| `chain` | The profile chain, showing how this pipeline was created.                                                          |
