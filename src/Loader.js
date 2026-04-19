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

/**
 * ============================================================================
 *  Loader.js — small, OPTIONAL convenience for managing a set of profiles
 * ============================================================================
 *
 *  This class is a lightweight registry on top of `Profile`. Use it when
 *  you want to declare a handful of profiles up-front, optionally
 *  preload them in parallel, and then look them up by a string key.
 *
 *  You DO NOT need `Loader` to use the engine — every transform path in
 *  jsColorEngine takes raw `Profile` instances. Loader is just sugar
 *  for "I have 5 profiles I always reach for, please load them once and
 *  let me ask for them by name."
 *
 *  ----------------------------------------------------------------------------
 *  TYPICAL USAGE
 *  ----------------------------------------------------------------------------
 *
 *      var loader = new Loader();
 *      loader.add('/profiles/sRGB.icc',       'sRGB',     true);   // preload
 *      loader.add('/profiles/AdobeRGB.icc',   'AdobeRGB', true);   // preload
 *      loader.add('/profiles/CoatedFOGRA.icc','FOGRA',    false);  // lazy
 *
 *      await loader.loadAll();                  // resolves preloaded profiles
 *      var sRGB  = await loader.get('sRGB');    // already in memory
 *      var fogra = await loader.get('FOGRA');   // loaded on first access
 *
 *  ----------------------------------------------------------------------------
 *  WHEN NOT TO USE
 *  ----------------------------------------------------------------------------
 *
 *    - Single profile? Just `new Profile().load(url)` — no need for Loader.
 *    - You already have your own caching layer (e.g. a CMS / framework).
 *    - You want fine-grained per-profile error handling — Loader's
 *      `loadAll` swallows individual errors and reports a count.
 *
 *  ----------------------------------------------------------------------------
 *  RESOLVED ISSUES (kept here for context; see CHANGELOG.md for details)
 *  ----------------------------------------------------------------------------
 *
 *    L1 (FIXED): `get(key)` previously called `loadProfileIndex(key)` —
 *        passing the string key where a numeric index was expected — so
 *        every lazy-load through `get()` threw a TypeError. Now resolves
 *        the index from the key first.
 *
 *    L2 (FIXED): `get()` previously crashed with "Cannot read .loaded of
 *        false" when the key wasn't registered. Now throws an explicit
 *        "no profile registered under key 'X'" error.
 *
 *    `findByKey` / `findByURL` still return `false` on miss (unchanged for
 *        backwards compatibility) — check the return value before reading
 *        properties off it.
 *
 * ============================================================================
 */

let Profile = require('./Profile.js');

class Loader {
    constructor() {
        this.profiles = [];
        this.loadCount = 0;
        this.errorCount = 0;
    }

    /**
     * Register a profile under the given URL and (optional) key. Does NOT
     * fetch — call `loadAll()` (for preload-flagged entries) or `get(key)`
     * (lazy) to actually load.
     *
     * @param {string} url       Source URL or path passed straight to
     *                           `Profile.load`.
     * @param {string} [key]     Lookup key. Defaults to `url`.
     * @param {boolean} [preload=false]
     *                           If true, `loadAll()` will fetch this one.
     * @returns {Profile}        The freshly created (unloaded) Profile.
     */
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

    /**
     * Load a single registered profile by its numeric index in
     * `this.profiles`. Idempotent: skips profiles that are already
     * loaded or in an error state.
     *
     * @param {number} index   Index into `this.profiles`.
     * @returns {Promise<boolean>}  true on success, false on error/skip.
     */
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

    /**
     * Sequentially load every profile flagged with `preload: true`. After
     * iteration, populates `this.loadCount` / `this.errorCount` and logs
     * a one-line summary.
     *
     * Note: loads are awaited one at a time, not in parallel — keeps
     * memory pressure predictable for large profile sets. If you need
     * parallel fetch, do it yourself with `Promise.all` over individual
     * `Profile.loadPromise` calls.
     *
     * @returns {Promise<void>}
     */
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

    /**
     * Resolve a registered profile by key. If already loaded, returns
     * immediately; otherwise attempts a lazy load and returns when done.
     *
     * @param {string} key
     * @returns {Promise<Profile>}
     * @throws  if no profile is registered under `key`, or if the lazy
     *          load fails.
     */
    async get(key) {
        // Find the registry entry by key (not just the Profile — we need the
        // index so we can lazy-load via loadProfileIndex).
        let index = -1;
        for (let i = 0; i < this.profiles.length; i++) {
            if (this.profiles[i].key === key) {
                index = i;
                break;
            }
        }

        if (index === -1) {
            throw new Error("Loader.get: no profile registered under key '" + key + "'");
        }

        let profile = this.profiles[index].profile;
        if (profile.loaded) {
            return profile;
        }

        // Lazy-load on first access. Previously this passed `key` (a string)
        // to loadProfileIndex (which expects a numeric index), so the lazy
        // path was completely broken — every get() of a non-preloaded
        // profile threw a TypeError. Now correctly passes the index.
        await this.loadProfileIndex(index);

        if (profile.loaded) {
            return profile;
        }

        let errText = (profile.lastError && profile.lastError.text)
            ? profile.lastError.text
            : 'unknown error';
        throw new Error("Loader.get: failed to load profile '" + key + "': " + errText);
    }

    /**
     * Linear scan for a registered profile by key.
     * @param {string} key
     * @returns {Profile|false}  The matching Profile, or `false` if none.
     */
    findByKey(key) {
        for(let i = 0; i < this.profiles.length; i++){
            if(this.profiles[i].key === key){
                return this.profiles[i].profile;
            }
        }
        return false;
    }

    /**
     * Linear scan for a registered profile by URL.
     * @param {string} url
     * @returns {Profile|false}  The matching Profile, or `false` if none.
     */
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