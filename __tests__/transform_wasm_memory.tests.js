/**
 * WASM memory management — compact, release, and auto-shrink tests.
 *
 * Coverage:
 *   1. compactWasmMemory() re-instantiates and resets memory to 1 page
 *   2. compactWasmMemory() — transform still produces correct output after
 *   3. releaseWasmMemory() — drops all WASM states to null
 *   4. releaseWasmMemory() — transform falls back to JS int kernel
 *   5. wasmMemoryBytes() — returns non-zero when WASM is active
 *   6. wasmMemoryBytes() — returns 0 after releaseWasmMemory()
 *   7. setWasmShrinkRatio() — auto-compact fires when memory is oversized
 *   8. setWasmShrinkRatio(0) — disables auto-compact
 *   9. wasmShrinkRatio option at create() time
 */

const {Transform, eIntent} = require('../src/main');
const path = require('path');

const describeIfWasm = (typeof WebAssembly !== 'undefined' && !process.env.SKIP_WASM_TESTS)
    ? describe
    : describe.skip;

function createWasmTransform(extraOpts) {
    var opts = Object.assign({
        dataFormat: 'int8',
        buildLut: true,
        lutMode: 'int-wasm-scalar',
        verbose: false,
    }, extraOpts || {});
    var t = new Transform(opts);
    t.create('*srgb', '*adobergb', eIntent.relative);
    return t;
}

function makeInput(pixelCount) {
    var arr = new Uint8ClampedArray(pixelCount * 3);
    for (var i = 0; i < arr.length; i++) arr[i] = i & 0xFF;
    return arr;
}

describeIfWasm('WASM memory management', () => {

    test('compactWasmMemory() resets memory to 1 page', () => {
        var t = createWasmTransform();
        var bigInput = makeInput(100000);
        t.transformArrayViaLUT(bigInput, false, false, false);
        expect(t.lastUsedKernel).toBe('kernel3D');

        var beforeBytes = t.wasmMemoryBytes();
        expect(beforeBytes).toBeGreaterThan(65536);

        t.compactWasmMemory();

        var afterBytes = t.wasmMemoryBytes();
        // Each live WASM state re-instantiates to 1 page (64 KB).
        // The Transform may have multiple states (3D scalar + 4D scalar).
        expect(afterBytes).toBeLessThanOrEqual(2 * 65536);
        expect(afterBytes).toBeLessThan(beforeBytes);
    });

    test('compactWasmMemory() — transform still correct after compact', () => {
        var t = createWasmTransform();
        var input = makeInput(1000);

        var refOut = t.transformArrayViaLUT(input, false, false, false);

        t.compactWasmMemory();

        var afterOut = t.transformArrayViaLUT(input, false, false, false);

        expect(Array.from(afterOut)).toEqual(Array.from(refOut));
    });

    test('releaseWasmMemory() drops all WASM states to null', () => {
        var t = createWasmTransform();
        expect(t.wasmTetra3D).not.toBeNull();

        t.releaseWasmMemory();

        expect(t.wasmTetra3D).toBeNull();
        expect(t.wasmTetra3DSimd).toBeNull();
        expect(t.wasmTetra4D).toBeNull();
    });

    test('releaseWasmMemory() — falls back to JS int kernel', () => {
        var intT = createWasmTransform({ lutMode: 'int' });
        var wasmT = createWasmTransform();

        var input = makeInput(1000);
        var refOut = intT.transformArrayViaLUT(input, false, false, false);

        wasmT.releaseWasmMemory();
        var afterOut = wasmT.transformArrayViaLUT(input, false, false, false);

        expect(Array.from(afterOut)).toEqual(Array.from(refOut));
    });

    test('wasmMemoryBytes() returns non-zero when WASM is active', () => {
        var t = createWasmTransform();
        var input = makeInput(1000);
        t.transformArrayViaLUT(input, false, false, false);

        expect(t.wasmMemoryBytes()).toBeGreaterThan(0);
    });

    test('wasmMemoryBytes() returns 0 after releaseWasmMemory()', () => {
        var t = createWasmTransform();
        t.releaseWasmMemory();
        expect(t.wasmMemoryBytes()).toBe(0);
    });

    test('setWasmShrinkRatio() auto-compacts when memory is oversized', () => {
        var t = createWasmTransform();

        var bigInput = makeInput(500000);
        t.transformArrayViaLUT(bigInput, false, false, false);
        var bigBytes = t.wasmMemoryBytes();

        t.setWasmShrinkRatio(2);

        // Must be above WASM_DISPATCH_MIN_PIXELS (256) to hit WASM bind()
        var smallInput = makeInput(500);
        t.transformArrayViaLUT(smallInput, false, false, false);
        var afterBytes = t.wasmMemoryBytes();

        expect(afterBytes).toBeLessThan(bigBytes);
    });

    test('setWasmShrinkRatio(0) disables auto-compact', () => {
        var t = createWasmTransform();

        var bigInput = makeInput(100000);
        t.transformArrayViaLUT(bigInput, false, false, false);
        var bigBytes = t.wasmMemoryBytes();

        t.setWasmShrinkRatio(0);

        var smallInput = makeInput(100);
        t.transformArrayViaLUT(smallInput, false, false, false);
        var afterBytes = t.wasmMemoryBytes();

        expect(afterBytes).toBe(bigBytes);
    });

    test('wasmShrinkRatio option at create() time', () => {
        var t = createWasmTransform({ wasmShrinkRatio: 2 });

        var bigInput = makeInput(500000);
        t.transformArrayViaLUT(bigInput, false, false, false);
        var bigBytes = t.wasmMemoryBytes();

        var smallInput = makeInput(500);
        t.transformArrayViaLUT(smallInput, false, false, false);
        var afterBytes = t.wasmMemoryBytes();

        expect(afterBytes).toBeLessThan(bigBytes);
    });

    test('wasmMaxMemory default is 128 MB', () => {
        var t = createWasmTransform();
        expect(t._wasmMaxMemory).toBe(128 * 1024 * 1024);
    });

    test('wasmMaxMemory: compacts immediately after exceeding ceiling', () => {
        var t = createWasmTransform({ wasmMaxMemory: 256 * 1024 });

        // Without ceiling: memory stays large after big image
        var tNoCeiling = createWasmTransform({ wasmMaxMemory: 0 });
        var bigInput = makeInput(100000);
        tNoCeiling.transformArrayViaLUT(bigInput, false, false, false);
        var uncappedBytes = tNoCeiling.wasmMemoryBytes();
        expect(uncappedBytes).toBeGreaterThan(256 * 1024);

        // With ceiling: post-run compaction fires, memory is small
        t.transformArrayViaLUT(bigInput, false, false, false);
        var cappedBytes = t.wasmMemoryBytes();
        expect(cappedBytes).toBeLessThan(uncappedBytes);
        expect(cappedBytes).toBeLessThanOrEqual(256 * 1024);
    });

    test('wasmMaxMemory: large image still processes correctly', () => {
        var intT = createWasmTransform({ lutMode: 'int', wasmMaxMemory: 0 });
        var t = createWasmTransform({ wasmMaxMemory: 256 * 1024 });

        var bigInput = makeInput(100000);
        var refOut = intT.transformArrayViaLUT(bigInput, false, false, false);
        var wasmOut = t.transformArrayViaLUT(bigInput, false, false, false);

        expect(Array.from(wasmOut)).toEqual(Array.from(refOut));
    });

    test('setWasmMaxMemory(0) disables the ceiling', () => {
        var t = createWasmTransform({ wasmMaxMemory: 256 * 1024 });
        t.setWasmMaxMemory(0);

        var bigInput = makeInput(100000);
        t.transformArrayViaLUT(bigInput, false, false, false);
        var bigBytes = t.wasmMemoryBytes();

        var smallInput = makeInput(500);
        t.transformArrayViaLUT(smallInput, false, false, false);
        var afterBytes = t.wasmMemoryBytes();

        expect(afterBytes).toBe(bigBytes);
    });

    test('setWasmMaxMemory() changes ceiling at runtime', () => {
        var t = createWasmTransform({ wasmMaxMemory: 0 });

        var bigInput = makeInput(100000);
        t.transformArrayViaLUT(bigInput, false, false, false);
        var bigBytes = t.wasmMemoryBytes();

        // Now enable a low ceiling
        t.setWasmMaxMemory(256 * 1024);

        var smallInput = makeInput(500);
        t.transformArrayViaLUT(smallInput, false, false, false);
        var afterBytes = t.wasmMemoryBytes();

        expect(afterBytes).toBeLessThan(bigBytes);
    });
});
