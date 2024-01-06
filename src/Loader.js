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

let Profile = require('./Profile.js');
class Loader {
    constructor() {
        this.profiles = [];
        this.loadCount = 0;
        this.errorCount = 0;
    }

    add(url, key, preload) {
        let profile = new Profile();
        this.profiles.push({
            profile: profile,
            url: url,
            preload: preload === true,
            key: (typeof key === 'undefined') ? url : key
        });
        return profile;
    }

    async loadProfileIndex(index) {
        let profile = this.profiles[index].profile;
        if (profile.loaded) {
            return true;
        }

        if (!profile.loadError) {
            try {
                return await profile.load(this.profiles[index].url);
            } catch (error) {
                return false;
            }
        }

        return false;
    }

    async loadAll() {
        //let toLoadCount = this.profiles.filter(p => p.preload && !p.profile.loaded).length;

        for (let p of this.profiles) {
            if (p.preload && !p.profile.loaded) {
                await p.profile.loadPromise(p.url);
            }
        }

        // check all profiles are loaded
        this.loadCount = 0;
        this.errorCount = 0;
        let preloadCount = 0;
        for(let i = 0; i < this.profiles.length; i++){
            if( this.profiles[i].preload){
                preloadCount++;
                let p = this.profiles[i].profile;
                if(p.loadError){
                    this.errorCount++;
                } else {
                    if(p.loaded){
                        this.loadCount++;
                    }
                }
            }

        }

        console.log("Loaded " + this.loadCount + " profiles with " + this.errorCount + " errors out of " + preloadCount + " profiles")

    }

    async get(key) {
        let profile = this.findByKey(key);
        if(profile.loaded){
            return profile;
        }

        // load the profile
        await this.loadProfileIndex(key);
        if(profile.loaded){
            return profile;
        }

        // Throw error if profile not found
        throw new Error("Unable to load the profile: " + key + " Error:" + profile.lastError.text);
    }

    findByKey(key) {
        for(let i = 0; i < this.profiles.length; i++){
            if(this.profiles[i].key === key){
                return this.profiles[i].profile;
            }
        }
        return false;
    }

    findByURL(url) {
        for(let i = 0; i < this.profiles.length; i++){
            if(this.profiles[i].url === url){
                return this.profiles[i].profile;
            }
        }
        return false;
    }
}

module.exports = Loader;