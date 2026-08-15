/*************************************************************************
 *  @license
 *
 *
 *  Copyright © 2019, 2024 Glenn Wilton
 *  O2 Creative Limited
 *  www.o2creative.co.nz
 *  support@o2creative.co.nz
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 */

var defs = require('./def');
var convert = require('./convert.js');

// Built-in kernel modules (1D-4D + ND) are registered inside Transform.js
// itself so direct require('./Transform.js') consumers get them too.
var Transform = require('./Transform.js');



module.exports  = {
    convert: convert, // backwards compatible
    color: convert, // Semantically better

    Spectral: require('./Spectral.js'),

    Loader: require('./Loader.js'),

    Profile: require('./Profile.js'),
    Transform: Transform,

    eColourType : defs.eColourType,
    eProfileType: defs.eProfileType,
    eIntent: defs.eIntent,
    encoding: defs.encoding,
    encodingStr: defs.encodingStr,

    // Version baked from package.json at build time by esbuild.
    // esbuild inlines require('../package.json').version as a string literal — the
    // full package.json is not included in the bundle.
    version: require('../package.json').version,
};