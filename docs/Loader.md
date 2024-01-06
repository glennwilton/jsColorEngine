# Loader Class

## Introduction
A **VERY BASIC** class used for managing and loading color profiles 
the application. It provides methods to queue profiles for loading and to load all 
queued profiles or to load a profile on demand.

## Methods

### add(url, key, preload)
This method is used to add a profile to the loading queue. It takes three parameters:
- `url`: The URL or path of the profile to be loaded.
- `key`: Unique ID of the profile. This is used to retrieve the profile from the cache.
- `preload`: Profile will be downloaded when using loadAll

### async loadAll()
This method is used to load all profiles that have been added to the queue. It doesn't take any parameters and returns a promise that resolves when all profiles have been loaded.

### async get(key)
This method is used to get a profile from the cache or download the profile if not already loaded.

### findByKey(key)
Returns the profile with the given key or false if not found.

### findByURL(url)
Returns the profile with the given url or false if not found.


## Usage
```js

    let loader = new Loader();

    loader.add('*lab', 'Lab',  true);
    loader.add('./profiles/srgb.icc', 'sRGB',  false);
    loader.add('./profiles/cmykPrinter.icc', 'CMYK',  false);
    
    await loader.loadAll();
    
    // Get the profiles, Loaded on demand
    let labProfile = await loader.get('Lab');
    let CMYKProfile = await loader.get('CMYK');
    
    if(labProfile.loaded && CMYKProfile.loaded) {
      // Create a transform
      var transform = new Transform();
      transform.create('*lab', CMYKProfile, eIntent.perceptual);
      
      var lab = convert.Lab(80.1, -22.3, 35.1);
      
      // convert the Lab color to CMYK
      let cmyk = transform.transform(lab);
      
      console.log(`CMYK: ${cmyk.C}, ${cmyk.M}, ${cmyk.Y}, ${cmyk.K}`);
    }


```