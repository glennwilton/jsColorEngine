
jsColorEngine is a colour management engine that uses ICC profiles to convert colors, written in 100% Javascript with no dependencies.

A lot of the core concepts and design ideas are based on LittleCMS but this is not a direct port.

## Install

Node `npm i jscolorengine`

```js
     (async () => {
        const {Profile, Transform, eIntent, convert} = require('jscolorengine');
      
        let labProfile = new Profile();
        labProfile.load('*lab');
      
        let rgbProfile = new Profile();
        await rgbProfile.loadPromise('./profiles/adobe1998.icc');
      
        let lab2RGB = new Transform();
        lab2RGB.create(labProfile, rgbProfile, eIntent.perceptual);
      
        let RGB = lab2RGB.transform(color.Lab(70, 30, 30));

        // Do stuff with RGB
  
    })();

```

From a Web Browser use [jsColorEngineWeb.js](./browser/jsColorEngineWeb.js)

```html
    <script src="jsColorEngineWeb.js"></script>
    <script>
        // jsColorEngine is now available as a global object 
        (async () => {

          let labProfile = new jsColorEngine.Profile();
          labProfile.load('*lab');

          let rgbProfile = new jsColorEngine.Profile();          
          await rgbProfile.loadPromise('./profiles/adobe1998.icc');

          let lab2RGB = new jsColorEngine.Transform();
          lab2RGB.create(labProfile, rgbProfile, jsColorEngine.eIntent.perceptual);

          let RGB = lab2RGB.transform(jsColorEngine.color.Lab(70, 30, 30));
          
          // Do stuff with RGB

        })();
        
    </script>
```

## Engine Features

- Supports most V2 and V4 ICC Profiles
  - LUT and matrix shaper 
  - Parametric Curves
  - LAB and XYZ PCS
  - Does not support Named Color Profiles, Device Link Profiles
- Transform features:
  - Trilinear and Tetrahedral interpolation
  - Blackpoint compensation
  - Multi step transforms profile > profile > profile...
  - Full debugging showing values at all steps
  - Prebuild transform into a LUT combined with optimised 3D/4D interpolation of arrays for high speed transforms
  - Insert custom pipeline stages, for example adjust saturation, convert to grey and changes will be saved into prebuilt LUT
  - Enable chromatic adaptation for abstract Lab profiles
- Different modes of operation
  - **Object to object Pipeline:** Ideal for analysis of colour, The engine will convert from input objects such as {L,a,b}
    to output objects such as {R:,G:,B:} or {C:, M:, Y:, K:} as floats, 8bit and 16bit data.
  - **Device to device Pipeline:** The engine will convert from arrays of floats, int8 and int16, such as [0,255,0] to [0,99,89,0]
  - **Image Conversions:** Build a LUT and convert from Uint8ClampedArray
    to Uint8ClampedArray, this is the fastest way to convert images for display. (but is less accurate than the pipeline).
- Supports input profiles
  - Grey
  - RGB (Lut and Matrix)
  - CMYK
  - Generic 2 Colour, 3 Colour, 4 Colour
  - _DeviceN > 4 channels not currently supported_ 
- Supports output profiles
  - Grey
  - RGB (Lut and Matrix)
  - CMYK
  - nChannels
- Built in virtual profiles
  - LabD50
  - LabD65
  - sRGB
  - Adobe1998
  - AppleRGB
  - Pro Photo
- Basic Profile Loader

## Color Conversion

Non ICC Color Conversion between color spaces
- RGB2Hex
- XYZ2xyY <> xyY2XYZ
- XYZ2Lab <> Lab2XYZ
- Lab2LCH <> LCH2Lab
- Lab2Lab with chromatic adaptation
- RGB2Lab <> Lab2RGB using matrix transforms
- XYZ2RGB <> RGB2XYZ using matrix transforms
- Lab2sRGB <> sRGB2Lab using built in sRGB matrix transforms
- Calculate Delta E, 
  - Delta E 2000
  - Delta E 94
  - Delta E 76
  - Delta E CMC
- Spectral Conversions
  - wavelength2RGB
  - Standard Illuminant's, A, C, D50, D55, D65
  - Standard Observer, 2, 10
  - Spectral data to XYZ using standard illuminant's and observer

## Accuracy

As a baseline for accuracy, I have compared the output with LittleCMS. 
The results are very close, but not identical, the differences are due
to JavaScript using 64bit floats throughout the pipeline, whereas 
LittleCMS switches in and out of double floats and 16bit integers. 
For the most part, the differences are very small and are not visible 
to the human eye.

In tests there are some larger differences in extreme cases,
such as converting from Lab 0,100,-100 to RGB, but this way out of
gamut and not a real world case and can be ignored. 

## How it works

The Transform Class is the core of the engine, it takes a source profile
and a destination profile and builds a transform pipeline between them, 
the pipeline is a series of stages, each stage is a function that takes 
the results from the previous stage and apply some transformation to the 
data, the pipeline is analysed and optimised to remove redundant stages,
the pipeline is then used to convert between the two profiles.

The process of building the pipeline is quite complex but does not need 
to be super efficient as it only happens once, to convert between two 
colours, we simply loop over the pipeline stages and call a function 
for each stage, and we return the result.

## Speed

If speed is important, A 1D, 2D, 3D or 4D LUT can be prebuilt when you 
create the transform, this **LUT (look up table)** can then be used to 
convert between the two profiles, and is 20-30x faster as there is only 
one step using an n-dimensional lookup table, but it is less accurate 
as the LUT has a finite resolution.

On my Anton 3700X I get 20-40 million pixels per second using a prebuilt
LUT, which is fast enough for most use cases.

## Documentation

   + [Profile Class](/docs/Profile.md)  
   + [Transform Class](/docs/Transform.md)
   + [Loader Class](/docs/Loader.md)
   + [Color Conversion](/docs/ColorConversion.md) (TODO)
   + [Color Types](/docs/ColorTypes.md) (TODO)

## Code Examples

### Converting CMYK imageData to RGB

```js
    var {Profile, Transform, eIntent} = require('colorEngine');

    // Load a profile
    var CMYKprofile = new Profile();
    await CMYKprofile.loadPromise('./profiles/CMYKProfile.icc');
    
    // Init Transform
    var cmyk2rgb = new Transform({
      buildLUT: true,
      dataFormat: 'int8',
      BPC: true
    });

    // Create transform pipeline, only need to do this ONCE when the app starts
    cmyk2rgb.create(CMYKprofile, '*srgb', eIntent.relative);
        
    function loadCMYKTIFF(url){
        // Load cmyk image data using whatever method you like
        let cmykData = loadTIFF('image.tiff');

        // convert from CMYK to RGBA
        return cmyk2rgb.transformArray(cmykData, true, false);
    }
```

### Converting an image to CMYK

For speed, we create a single Lookup-up-table from the profiles and then
use the optimised transformArray function to convert the image data.

```js
    // Convert an image
    var {Profile, Transform, eIntent} = require('colorEngine');

    // Load a profile
    var CMYKprofile = new Profile();
    await CMYKprofile.loadPromise('./profiles/CMYKProfile.icc');
    
    // Create  transforms
    var rgb2cmyk = new Transform({
      buildLUT: true,
      dataFormat: 'int8',
      BPC: true
    });
    
    rgb2cmyk.create('*srgb', CMYKprofile, eIntent.perceptual);

    var cmyk2rgb = new Transform({
      buildLUT: true,
      dataFormat: 'int8',
      BPC: true // Enbalck black point compensation
    });
    
    cmyk2rgb.create(CMYKprofile, '*srgb', eIntent.relative);

    // Convert an image
    var image = new Image();
    image.src = 'image.jpg';
    image.onload = function() {
        var canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        var imageData = ctx.getImageData(0, 0, image.width, image.height);
        var data = imageData.data;

        // convert from RGB to CMYK
        var cmykData = rgb2cmyk.transformArray(imageData.data, true, false);
    
        // convert from CMYK to RGB
        var rgbData = cmyk2rgb.transformArray(cmykData, false, true);
        
        ctx.putImageData(rgbData, 0, 0);
        document.body.appendChild(canvas);
    }
```

### Converting from LabD50 to a CMYK color

```js

    var {Profile, Transform, eIntent} = require('colorEngine');

    // Load a profile
    var CMYKprofile = new Profile();
    await CMYKprofile.loadPromise('./profiles/CMYKProfile.icc');
    
    // Create a transform
    var transform = new Transform();
    transform.create('*lab', CMYKprofile, eIntent.perceptual);
    
    var lab = color.Lab(80.1, -22.3, 35.1);
    
    // convert the Lab color to CMYK
    let cmyk = transform.transform(lab);
    
    console.log(`CMYK: ${cmyk.C}, ${cmyk.M}, ${cmyk.Y}, ${cmyk.K}`);

```

### To soft proof what an RGB image would look like in CMYK

We create a multi-step transform, this will convert from RGB to CMYK,
then CMYK to RGB. In this process the final RGB image will be adjusted
to simulate what it would look like if it was printed on a CMYK printer.

```js
    // Convert an image
    var {Profile, Transform, eIntent} = require('colorEngine');

    // Load a profile
    var CMYKprofile = new Profile();
    await CMYKprofile.loadPromise('./profiles/CMYKProfile.icc');
    
    // Create multi stage transforms
    var proofTransform = new Transform({
      buildLUT: true,
      dataFormat: 'int8',
      BPC: [true, false] // Enable blackpoint compensation on preceptional intent but not relative
    });
    proofTransform.createMultiStage(['*srgb', eIntent.perceptual, CMYKprofile, eIntent.relative, '*srgb']);

    // Convert an image
    var image = new Image();
    image.src = 'image.jpg';
    image.onload = function() {
        var canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        var imageData = ctx.getImageData(0, 0, image.width, image.height);
        
        // convert RGB to RGB with soft proofing
        var data = proofTransform.transformArray(imageData.data, true, true, true);
    
        ctx.putImageData(data, 0, 0);
        document.body.appendChild(canvas);
    }
```

### Insert a custom stage to convert to grey

We will insert a custom stage into the pipeline at the PCS to convert
the color to Gray

```js

    var {Profile, Transform, eIntent, encoding} = require('colorEngine');

    // Load a profile
    var CMYKprofile = new Profile();
    await CMYKprofile.loadPromise('./profiles/CMYKProfile.icc');

    var PCStoGrey = {
        description: 'Convert to Grey',
        location: 'PCS',
        stageData: null,
        stageFn: function(input, data, stage) {
            if(stage.inputEncoding === encoding.PCSXYZ){
                // Set the X and Z components to Y (rough, but good enough for this example)
                input[0] = input[1]
                input[2] = input[1]
            } else {
                // in Lab PCS encoding
                input[1] = 0.5; // Sets a component to 0 
                input[2] = 0.5; // Sets a component to 0             
            }
            return input;        
        }        
    }
    
    // Create a transform
    var transform = new Transform();
    transform.create('*lab', CMYKprofile, eIntent.perceptual, [PCStoGrey]);

    

```


## License

GPLv3

jsColorEngine is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of the License,
or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program.
If not, see <https://www.gnu.org/licenses/>.

Portions of this software are based on the work of the following:
- LittleCMS (www.littlecms.com)
