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

module.exports  = {
    convert: convert, // backwards compatable
    color: convert, // Semantically better

    Spectral: require('./Spectral.js'),

    Loader: require('./Loader.js'),

    Profile: require('./Profile.js'),
    Transform: require('./Transform.js'),

    eColourType : defs.eColourType,
    eProfileType: defs.eProfileType,
    eIntent: defs.eIntent,
    encoding: defs.encoding,
    encodingStr: defs.encodingStr,
};