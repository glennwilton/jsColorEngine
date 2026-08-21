// shared-resources.js
//
// Single source of truth for pixel input/output buffers.
// Profile loading is handled by the environment loaders (nodeLoader / webLoader)
// which pass pre-loaded bytes into the group engines. This module only owns
// the deterministic pixel data so every engine sees identical input bytes.

export class ResourcePool {
    constructor() {
        this.testData = new Map();   // pixelCount -> { rgbIn, cmykIn }
        this.loaded   = false;
    }

    reset() {
        this.testData.clear();
        this.loaded = false;
    }

    async initialize(config = {}) {
        if (this.loaded) return;

        const seed        = config.seed        ?? 0x12345678;
        const pixelCounts = config.pixelCounts ?? [32_768, 65_536, 1_000_000, 10_000_000];

        for (const pixelCount of pixelCounts) {
            this.testData.set(pixelCount, {
                rgbIn:  { label: `RGB input (${pixelCount} px)`,  bin: this._gen(pixelCount * 3, seed)     },
                cmykIn: { label: `CMYK input (${pixelCount} px)`, bin: this._gen(pixelCount * 4, seed + 1) },
            });
        }

        this.loaded = true;
    }

    // Deterministic LCG — same seed produces identical bytes every run.
    _gen(byteCount, seed) {
        const data = new Uint8Array(byteCount);
        let rng = seed >>> 0;
        for (let i = 0; i < byteCount; i++) {
            rng = (rng * 1664525 + 1013904223) >>> 0;
            data[i] = rng >>> 24;
        }
        return data;
    }

    getTestData(pixelCount) {
        if (!this.testData.has(pixelCount)) {
            throw new Error(`No test data for ${pixelCount} px. Available: ${[...this.testData.keys()].join(', ')}`);
        }
        return this.testData.get(pixelCount);
    }

    // Always allocate a fresh buffer — never reuse across timed runs.
    // Reuse hides allocation cost and can warm/pollute caches.
    createOutputBuffer(type, pixelCount) {
        const channels = type === 'cmyk' ? 4 : 3;
        return {
            label: `${type.toUpperCase()} output (${pixelCount} px)`,
            bin:   new Uint8Array(pixelCount * channels),
        };
    }
}

export const resources = new ResourcePool();
