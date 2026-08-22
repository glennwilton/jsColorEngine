'use strict';

/**
 * Assert what array() / transformArray() / ViaLUT actually ran.
 * Tokens: kernel1D..kernel6D, kernelND, kernelIdentity, matrix-shaper,
 * pipeline, cache. ViaLUT throw leaves the field unchanged (null until
 * the first successful batch).
 */
function expectRoute(t, name){
    expect(t.lastUsedKernel).toBe(name);
}

function routeForInputChannels(inCh, sameFile){
    if(sameFile) return 'kernelIdentity';
    if(inCh === 1) return 'kernel1D';
    if(inCh === 2) return 'kernel2D';
    if(inCh === 3) return 'kernel3D';
    if(inCh === 4) return 'kernel4D';
    if(inCh === 5) return 'kernel5D';
    if(inCh === 6) return 'kernel6D';
    return 'pipeline';
}

module.exports = { expectRoute, routeForInputChannels };
