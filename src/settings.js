/*************************************************************************
 *  @license
 *
 *  Copyright © 2019, 2026 Glenn Wilton
 *  O2 Creative Limited
 *  www.o2creative.co.nz
 *  support@o2creative.co.nz
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 */

/**
 * settings.js — host-level settings, read the same way on both hosts.
 *
 *   Node     JSCE_POOL_CORES=4 node app.js
 *   Browser  globalThis.JSCE_POOL_CORES = 4;      // or window.
 *
 * ONE SET OF NAMES, TWO PLACES TO PUT THEM. `globalThis` is checked first,
 * then `process.env` — so the documentation lists one key per setting rather
 * than a Node spelling and a browser spelling, and a value set in code beats
 * one inherited from the shell, which is the order a developer expects when
 * they are trying to override something.
 *
 * WHAT BELONGS HERE, AND WHAT DOES NOT
 *
 * Only settings that CANNOT CHANGE A PIXEL:
 *
 *   - Deployment: how many workers, how long they idle, how much they cache.
 *     Properties of the machine, not of the conversion. The motivating case is
 *     a cgroup-limited container, where `os.availableParallelism()` reports the
 *     host's cores rather than the quota.
 *   - Diagnosis: pinning an implementation to rule a WASM problem in or out in
 *     the field, without a code change or a rebuild.
 *
 * Colour behaviour is deliberately NOT configurable this way. Ambient state
 * that changes output is how a bug report becomes unreproducible — the same
 * code on the same input gives two answers and nothing in the code says why.
 * Defaults that move pixels are pinned explicitly and visibly, in code, with
 * `Transform.compatibility('1.5')`.
 */
'use strict';

/**
 * Read a setting: `globalThis[name]` first, then `process.env[name]`.
 * Returns undefined when neither is set or the value is empty.
 */
function raw(name){
    try {
        if(typeof globalThis !== 'undefined' && globalThis[name] !== undefined
           && globalThis[name] !== null && globalThis[name] !== ''){
            return globalThis[name];
        }
    } catch(e){ /* exotic host with a hostile global */ }
    try {
        if(typeof process !== 'undefined' && process.env){
            var v = process.env[name];
            if(v !== undefined && v !== '') return v;
        }
    } catch(e){ /* no process, e.g. a browser */ }
    return undefined;
}

/**
 * One of `allowed`, or undefined. Warns once on an unrecognised value.
 *
 * `quiet` suppresses the warning for a setting that accepts more than one KIND
 * of value — `JSCE_POOL_CORES` takes 'auto', 'max' or a number, so the enum
 * check must not complain about "4" before the numeric check has seen it.
 */
function readEnum(name, allowed, quiet){
    var v = raw(name);
    if(v === undefined) return undefined;
    v = String(v);
    if(allowed.indexOf(v) !== -1) return v;
    if(!quiet) warnOnce(name, v, allowed.join(' | '));
    return undefined;
}

/**
 * 'auto' | 'max' | a non-negative number, or undefined — one setting that
 * accepts either, warning once with BOTH options rather than whichever check
 * happened to run first.
 */
function readEnumOrNumber(name, allowed){
    var v = raw(name);
    if(v === undefined) return undefined;
    var e = readEnum(name, allowed, true);
    if(e !== undefined) return e;
    var n = Number(v);
    if(isFinite(n) && n >= 0) return n;
    warnOnce(name, v, allowed.join(' | ') + ' or a non-negative number');
    return undefined;
}

/** A non-negative number, or undefined. Warns once on nonsense. */
function readNumber(name){
    var v = raw(name);
    if(v === undefined) return undefined;
    var n = Number(v);
    if(!isFinite(n) || n < 0){
        warnOnce(name, v, 'a non-negative number');
        return undefined;
    }
    return n;
}

/** True only for an explicit truthy spelling. */
function readFlag(name){
    var v = raw(name);
    if(v === undefined) return false;
    v = String(v).toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

// Silently ignoring a typo would be worse than ignoring the setting: the
// operator believes it took effect and the machine says nothing. Warn once per
// key, so a per-call read cannot turn into a per-call log.
var warned = {};
function warnOnce(name, value, expected){
    if(warned[name]) return;
    warned[name] = true;
    if(typeof console !== 'undefined' && console.warn){
        console.warn('jsColorEngine: ignoring ' + name + '="' + value +
                     '" — expected ' + expected + '.');
    }
}

module.exports = {
    raw: raw,
    readEnum: readEnum,
    readEnumOrNumber: readEnumOrNumber,
    readNumber: readNumber,
    readFlag: readFlag,
    /** Test seam: forget which keys have already warned. */
    _resetWarnings: function(){ warned = {}; }
};
