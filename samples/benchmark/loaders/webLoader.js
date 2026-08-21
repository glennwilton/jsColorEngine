// loaders/webLoader.js
//
// Browser environment loader. Fetches ICC profiles via HTTP and expects
// jsColorEngine to be available as window.jsColorEngine (loaded via <script>).
// Optionally loads lcms-wasm via dynamic ESM import.
//
// Paths are relative to samples/ so this works regardless of domain/subdirectory.

const PROFILE_URLS = {
    AdobeRGB:  '../profiles/AdobeRGB1998.icc',
    GRACoL:    '../profiles/CoatedGRACoL2006.icc',
    ISOCoated: '../profiles/ISOcoated_v2_eci.icc',
};

const LCMS_DIST = '../../lcms-wasm-dist/';

async function fetchBytes(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`fetch ${url}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

export async function load() {
    const profileEntries = await Promise.all(
        Object.entries(PROFILE_URLS).map(async ([name, url]) => [name, await fetchBytes(url)])
    );
    const profiles = Object.fromEntries(profileEntries);

    const jsce = (typeof window !== 'undefined' && window.jsColorEngine) || null;
    if (!jsce) throw new Error('jsColorEngine not on window — add <script src="../browser/jsColorEngineWeb.js"> before the bench');

    // TODO: wire up lcms group when browser UI is built
    let lcms = null;
    try {
        const mod = await import(LCMS_DIST + 'lcms.js');
        lcms = await mod.instantiate({ locateFile: (name) => LCMS_DIST + name });
    } catch (error) {
        console.warn('[webLoader] lcms-wasm unavailable:', error.message);
    }

    return { profiles, jsce, lcms };
}
