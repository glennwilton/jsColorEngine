The `Profile` class Loads and decodes ICC Profiles without performing color conversions.

* Capability to handle profiles from various sources, such as binary arrays, URLs, base64 encoded strings, or creating virtual profiles like sRGB or Adobe RGB.
* Support for both ICC Profile versions 2 and 4.
* Compatibility with various profile types, including RGB, Gray, Lab, and CMYK. RGB profiles can be either matrix-based or LUT-based.

Note that the `Profile` class does not perform color conversions. For this purpose, use the `Transform` class.

### Loading Profiles

Call the generic methods for loading a profile, either

+ `profile.load(dataOrUrl, afterLoad)`
+ `profile.loadPromise(dataOrUrl)`

| dataOrUrl        | Description                        |
|------------------|------------------------------------|
| Uint8Array       | Load from binary Uint8Array        |
| 'data:base64...' | Load from base64 encoded string    |
| 'url'            | Load via XHR HTTP                  |
| '*name'          | A virtual profile name (see below) |


### Virtual profiles
To load a built-in virtual profile use the name prefixed with a '*'

| Name           | Description      |
|----------------|------------------|
| *sRGB          | sRGB             |
| *AdobeRGB      | Adobe RGB (1998) |
| *AppleRGB      | Apple RGB        |
| *ColorMatchRGB | ColorMatch RGB   |
| *ProPhotoRGB   | ProPhoto RGB     |
| *Lab           | Lab D50*         |
| *LabD50        | Lab D50*         |
| *LabD65        | Lab D65*         |

** Note that Lab profiles are abstract profiles, 
and according to the ICC specification the engine
will no 


### Profile Methods

| Function                  | Arguments                                                                                              | Description                                                                                              |
|---------------------------|--------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------|
| `constructor`           | `dataOrUrl`: Uint8Array/String, `afterLoad`: function(profile)                                         | Initializes a new Profile instance, optionally loading a profile.                                        |
| `loadPromise`           | `dataOrUrl`: Uint8Array/String                                                                         | Returns a Promise that resolves after loading a profile.                                                 |
| `load`                  | `dataOrUrl`: Uint8Array/String, `afterLoad`: function(profile)                                         | Loads a profile from various sources like Uint8Array, URL, base64 string, file path, or virtual profile. |
| `loadBinary`            | `binary`: Uint8Array, `afterLoad`: function(profile), `searchForProfile`: Boolean                      | Loads a profile from a binary array, optionally searching for the ICC profile within the array.          |
| `loadFile`              | `filename`: String, `afterLoad`: function(profile)                                                     | Loads a profile from a local file path. (In nodeJS)                                                      |
| `loadBase64`            | `base64`: String, `afterLoad`: function(profile)                                                       | Loads a profile from a base64 encoded string.                                                            |
| `loadURL`               | `url`: String, `afterLoad`: function(profile)                                                          | Loads a profile from a URL using an XHR request.                                                         |
| `loadVirtualProfile`    | `name`: String, `afterLoad`: function(profile)                                                         | Creates and loads a virtual profile, such as sRGB, Adobe RGB, Lab D50, etc.                              |

This table provides an overview of the functions available in the `Profile` class, excluding internal private methods. Each function's purpose and its parameters are clearly outlined.

### Profile Properties

List of userful properties of the `Profile` class.

| Property               | Type     | Description                                            |
|------------------------|----------|--------------------------------------------------------|
| `loaded`               | Boolean  | Indicates if the profile has been successfully loaded. |
| `lastError`            | Object   | Contains the last error information.                   |
| `type`                 | Integer  | Type of the profile (e.g., RGB, CMYK, Gray).           |
| `name`                 | String   | Name of the profile.                                   |
| `header`               | Object   | Contains header information of the ICC profile.        |
| `intent`               | Integer  | Default Rendering intent for the profile.              |
| `description`          | String   | Description of the profile.                            |
| `copyright`            | String   | Copyright information of the profile.                  |
| `technology`           | String   | Information about the technology of the profile.       |
| `mediaWhitePoint`      | Object   | Media white point data.                                |
| `outputChannels`       | Integer  | Number of output channels.                             |

