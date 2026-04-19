// Regression tests for the recent Loader.get() fixes:
//
// L1: get(key) used to call loadProfileIndex(key) — passing the string
//     key where a numeric index was expected. The lazy-load path threw
//     a TypeError every time. Now correctly resolves the index first.
//
// L2: get(key) for an unregistered key used to crash reading
//     `.loaded` off `false`. Now throws an explicit registry-miss error.

const {Loader, Profile} = require('../src/main');
const path = require('path');

const cmykFilename = path.join(__dirname, './GRACoL2006_Coated1v2.icc');

describe('Loader basic registration', () => {

    test('add + findByKey returns the registered Profile', () => {
        const loader = new Loader();
        loader.add('*lab', 'Lab', true);
        const p = loader.findByKey('Lab');
        expect(p).toBeInstanceOf(Profile);
    });

    test('findByKey returns false for an unregistered key', () => {
        const loader = new Loader();
        expect(loader.findByKey('Nope')).toBe(false);
    });
});

describe('Loader.loadAll() preloads only flagged entries', () => {

    test('preload=true entries load, preload=false entries do not', async () => {
        const loader = new Loader();
        loader.add('*lab', 'Lab', true);
        loader.add('file:' + cmykFilename, 'CMYK', false);

        await loader.loadAll();

        expect(loader.findByKey('Lab').loaded).toBe(true);
        expect(loader.findByKey('CMYK').loaded).toBe(false);
    });
});

describe('Loader.get() — fixed L1 + L2 paths', () => {

    test('get() of a preloaded key returns the loaded profile', async () => {
        const loader = new Loader();
        loader.add('*lab', 'Lab', true);
        await loader.loadAll();

        const p = await loader.get('Lab');
        expect(p.loaded).toBe(true);
    });

    test('get() of a non-preloaded key lazily loads it (L1 fix)', async () => {
        const loader = new Loader();
        loader.add('file:' + cmykFilename, 'CMYK', false);
        // No loadAll() — get() must do the load itself.

        const p = await loader.get('CMYK');
        expect(p.loaded).toBe(true);
        expect(p.outputChannels).toBe(4);
    });

    test('get() of an unregistered key throws an explicit error (L2 fix)', async () => {
        const loader = new Loader();
        loader.add('*lab', 'Lab', true);
        await loader.loadAll();

        await expect(loader.get('Bogus')).rejects.toThrow(/no profile registered/);
    });
});
