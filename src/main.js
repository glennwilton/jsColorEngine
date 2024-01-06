/*************************************************************************
 *  @license
 *
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

var defs = require('./def');

module.exports  = {
    convert: require('./convert.js'),

    Spectral: require('./Spectral.js'),

    Loader: require('./Loader.js'),

    Profile: require('./Profile.js'),
    Transform: require('./Transform.js'),

    eColourType : defs.eColourType,
    eProfileType: defs.eProfileType,
    eIntent: defs.eIntent
};