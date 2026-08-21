// loaders/nodeLoader.js
//
// Node.js environment loader. Reads ICC profiles from disk and imports
// jsColorEngine from the package source. Returns the same shape as
// webLoader.js so main.js can call either interchangeably.

import * as fs   from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dirname     = path.dirname(fileURLToPath(import.meta.url));
const profilesDir = path.resolve(dirname, '../../profiles');
const jscePath    = path.resolve(dirname, '../../../src/main.js');

export async function load() {
    const [adobeRGBData, gracolData, isoCoatedData] = await Promise.all([
        fs.readFile(path.join(profilesDir, 'AdobeRGB1998.icc')),
        fs.readFile(path.join(profilesDir, 'CoatedGRACoL2006.icc')),
        fs.readFile(path.join(profilesDir, 'ISOcoated_v2_eci.icc')),
    ]);

    // CJS module imported from ESM — module.exports becomes the default export.
    // On Windows, absolute paths must be file:// URLs for ESM import().
    const jsce = (await import(pathToFileURL(jscePath).href)).default;

    return {
        profiles: {
            AdobeRGB:  new Uint8Array(adobeRGBData),
            GRACoL:    new Uint8Array(gracolData),
            ISOCoated: new Uint8Array(isoCoatedData),
        },
        jsce,
        lcms: null,
    };
}
