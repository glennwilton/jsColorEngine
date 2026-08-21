/**
 * Kernel dispatch — coverage + equivalence tests.
 *
 * Each kernel owns its dispatch, in its own kernelND_table.js, and is
 * for "what kernel runs for (lutMode, inputChannels, outputChannels)?".
 * Resolution happens once at the end of Transform.create() and caches
 * BIG/SMALL run closures + a threshold on the Transform itself. Per-call
 * dispatch is then one threshold compare + one indirect call.
 *
 * Coverage:
 *
 *  1. Table integrity
 *      1a. KERNEL is exhaustive: every LUT_MODE_SHORT × inCh{3,4} ×
 *          outBucket{3,4,n} cell has an entry.
 *      1b. Every entry has the {run, gate, minPx, fallback} shape.
 *      1c. Every non-null fallback key resolves to another KERNEL entry.
 *      1d. Every chain terminates at an fl_*_* entry with fallback:null.
 *      1e. No cycles (depth ≤ 16 from any starting key).
 *
 *  2. Resolver behaviour
 *      2a. Float entries always win (gate=alwaysOk, minPx=0) regardless
 *          of WASM state.
 *      2b. WASM-eligible entries are skipped at pixelCountFloor=0,
 *          chosen at pixelCountFloor=Infinity (when state is loaded).
 *      2c. Sparse passthrough (run:null, gate:alwaysFalse) advances to
 *          fallback transparently.
 *
 *  3. Transform integration
 *      3a. _resolveLutKernels() runs at end of create(), populates
 *          _lutKernelBig / _lutKernelSmall / _lutKernelThreshold.
 *      3b. inputChannels ∈ {1, 2} leaves the cache null (gray/duotone
 *          aren't table-dispatched).
 *      3c. _lutKernelThreshold is 0 when BIG and SMALL collapse to the
 *          same entry (no WASM win possible).
 *
 *
 * Skip strategy mirrors the WASM test suites: WASM tests gate on
 * (typeof WebAssembly !== 'undefined' && !process.env.SKIP_WASM_TESTS).
 */

'use strict';

const path = require('path');
const { Transform, eIntent } = require('../src/main');
const Profile = require('../src/Profile');
const lutKernelTable = require('../src/lutKernelTable');

const cmykFilename = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');

const HAS_WASM = typeof WebAssembly !== 'undefined' && !process.env.SKIP_WASM_TESTS;

// Mock Transform-like object with selectable WASM states.
function mockTransform(opts){
    return {
        outputChannels:        opts.outputChannels || 3,
        wasmTetra3D:           opts.wasmTetra3D           || null,
        wasmTetra3DSimd:       opts.wasmTetra3DSimd       || null,
        wasmTetra3DInt16:      opts.wasmTetra3DInt16      || null,
        wasmTetra3DInt16Simd:  opts.wasmTetra3DInt16Simd  || null,
        wasmTetra4D:           opts.wasmTetra4D           || null,
        wasmTetra4DSimd:       opts.wasmTetra4DSimd       || null,
        wasmTetra4DInt16:      opts.wasmTetra4DInt16      || null,
        wasmTetra4DInt16Simd:  opts.wasmTetra4DInt16Simd  || null,
    };
}

// ============================================================================
// 1. DISPATCH DECISIONS — the switch that replaced the table
// ============================================================================

describe('kernel dispatch — the switch that replaced the table', () => {

    // Dispatch used to be a 42-row table of {run, gate, minPx, fallback} keyed
    // by strings like 'i8wsi_3_4', walked by a generic resolver that built the
    // key, looked up the row, called a gate closure and followed `fallback`
    // until something answered.
    //
    // That was right when Transform.js dispatched for every dimension out of
    // one flat structure: it had to be data rather than code. Once the rows
    // moved into the kernels that own them, a kernel was reaching through two
    // modules and building a key string to look up a table sitting in its own
    // file. It is a switch now, one per kernel.
    //
    // These tests are the ones the structural suite could not be. That suite
    // checked the table had no cycles and every cell had a fallback; this
    // checks the DECISIONS, which is what anybody actually depends on.

    const t3 = require('../src/kernels/3d/kernel3D_table.js');
    const t4 = require('../src/kernels/4d/kernel4D_table.js');

    const SLOTS = ['wasmTetra3D', 'wasmTetra3DSimd', 'wasmTetra3DInt16', 'wasmTetra3DInt16Simd',
                   'wasmTetra4D', 'wasmTetra4DSimd', 'wasmTetra4DInt16', 'wasmTetra4DInt16Simd'];
    const MODES = ['float', 'int', 'int16', 'int-wasm-scalar', 'int-wasm-simd',
                   'int16-wasm-scalar', 'int16-wasm-simd'];
    const DIMS  = [[3, t3], [4, t4]];

    function kernelFor(mode, outputChannels, loaded){
        const k = { transform: { lutMode: mode, outputChannels: outputChannels } };
        for(const s of SLOTS) k[s] = (loaded === 'all' || (loaded || []).indexOf(s) !== -1) ? {} : null;
        return k;
    }
    function lutFor(inCh, outCh, intLut){
        return { inputChannels: inCh, outputChannels: outCh, intLut: intLut ? {} : null };
    }

    test('EVERY input width reaches EVERY output width, in every mode', () => {
        // The matrix that would have caught the bug this replaced: int16 modes
        // could not reach 5 or more output channels at all, so CMYK to 5CLR
        // worked at 8 bits and threw at 16.
        for(const [dim, mod] of DIMS){
            for(const mode of MODES){
                for(const outCh of [1, 2, 3, 4, 5, 6, 8, 12, 15]){
                    const picked = mod.resolve(kernelFor(mode, outCh, 'all'), lutFor(dim, outCh, true));
                    expect(typeof picked.big).toBe('function');
                    expect(typeof picked.small).toBe('function');
                }
            }
        }
    });

    test('wide output in a u16 mode lands on float, never on a u8 kernel', () => {
        // Float is the one legal cross-family landing point: it scales through
        // lut.outputScale at call time, which an int16 mode has already folded
        // to 65535. A u8 kernel writing into a Uint16Array would divide every
        // value by about 257 and look almost right.
        for(const [dim, mod] of DIMS){
            for(const mode of ['int16', 'int16-wasm-scalar', 'int16-wasm-simd']){
                const picked = mod.resolve(kernelFor(mode, 6, 'all'), lutFor(dim, 6, true));
                expect(picked.smallName).toBe('fl_' + dim + '_n');
                expect(picked.bigName).not.toMatch(/^i_/);
                expect(picked.bigName).not.toMatch(/^i8/);
            }
        }
    });

    test('an int16 mode with no intLut degrades to float rather than throwing', () => {
        // It threw until v1.6, on the reasoning that asking for 16-bit kernels
        // without building their table is misuse rather than a shape we cannot
        // serve. The u8 family never took that view -- it degrades to float
        // silently in the identical position -- and the inconsistency meant
        // dataFormat:'int16' could not reach a 5-or-more-channel profile at
        // all, because buildIntLut() does not produce a table that wide.
        //
        // Float is legal here: lut.outputScale is folded to 65535 in an int16
        // mode and the float run scales at call time.
        for(const [dim, mod] of DIMS){
            for(const mode of ['int16', 'int16-wasm-scalar', 'int16-wasm-simd']){
                for(const outCh of [3, 4, 6, 15]){
                    const picked = mod.resolve(kernelFor(mode, outCh, 'all'), lutFor(dim, outCh, false));
                    const expected = (outCh === 3 || outCh === 4)
                        ? 'fl_' + dim + '_' + outCh
                        : 'fl_' + dim + '_n';
                    expect(picked.bigName).toBe(expected);
                }
            }
        }
    });

    test('float always wins, whatever the WASM state', () => {
        for(const [dim, mod] of DIMS){
            for(const loaded of ['all', []]){
                for(const intLut of [true, false]){
                    const picked = mod.resolve(kernelFor('float', 4, loaded), lutFor(dim, 4, intLut));
                    expect(picked.bigName).toBe('fl_' + dim + '_4');
                    expect(picked.big).toBe(picked.small);
                }
            }
        }
    });

    test('without an intLut, the u8 integer modes degrade to float', () => {
        for(const [dim, mod] of DIMS){
            for(const mode of ['int', 'int-wasm-scalar', 'int-wasm-simd']){
                const picked = mod.resolve(kernelFor(mode, 4, 'all'), lutFor(dim, 4, false));
                expect(picked.bigName).toBe('fl_' + dim + '_4');
            }
        }
    });

    test('BIG takes WASM, SMALL stays on JS — the memcpy break-even', () => {
        for(const [dim, mod] of DIMS){
            const simd = mod.resolve(kernelFor('int-wasm-simd', 4, 'all'), lutFor(dim, 4, true));
            expect(simd.bigName).toBe('i8wsi_' + dim + '_4');
            expect(simd.smallName).toBe('i_' + dim + '_4');
            expect(simd.big).not.toBe(simd.small);

            // Nothing loaded: both collapse to the JS kernel, and a caller
            // holding both needs no comparison at all.
            const none = mod.resolve(kernelFor('int-wasm-simd', 4, []), lutFor(dim, 4, true));
            expect(none.bigName).toBe('i_' + dim + '_4');
            expect(none.big).toBe(none.small);
        }
    });

    test('SIMD covers 3 and 4 output channels only; wider takes the scalar kernel', () => {
        for(const [dim, mod] of DIMS){
            for(const outCh of [3, 4]){
                expect(mod.resolve(kernelFor('int-wasm-simd', outCh, 'all'),
                                   lutFor(dim, outCh, true)).bigName)
                    .toBe('i8wsi_' + dim + '_' + outCh);
            }
            expect(mod.resolve(kernelFor('int-wasm-simd', 6, 'all'), lutFor(dim, 6, true)).bigName)
                .toBe('i8ws_' + dim + '_n');
        }
    });

    test('a mode only ever degrades — it never gains a capability', () => {
        // simd to scalar to js to float, one direction. Asserted by checking
        // that taking a module away never improves the answer.
        const rank = n => (n.indexOf('i8wsi') === 0 || n.indexOf('i16wsi') === 0) ? 4
                        : (n.indexOf('i8ws') === 0 || n.indexOf('i16ws') === 0)   ? 3
                        : (n.indexOf('i_') === 0 || n.indexOf('i16_') === 0)      ? 2 : 1;
        for(const [dim, mod] of DIMS){
            for(const mode of MODES){
                for(const outCh of [3, 4, 6]){
                    const all  = mod.resolve(kernelFor(mode, outCh, 'all'), lutFor(dim, outCh, true));
                    const none = mod.resolve(kernelFor(mode, outCh, []),    lutFor(dim, outCh, true));
                    expect(rank(none.bigName)).toBeLessThanOrEqual(rank(all.bigName));
                }
            }
        }
    });
});

describe('the kernel resolves its own image path, in init()', () => {

    // NOBODY OUTSIDE THE KERNEL READS THESE. arrayFnBig / arrayFnSml /
    // threshold are the kernel's own fields, written by its init() and read
    // only by its array(). These tests reach in because a test is allowed to;
    // the point of the assertions is that create() alone is enough to settle
    // them, with no resolve step sequenced from Transform.
    //
    // Until v1.6 there was one: Transform._resolveLutKernels() called
    // kernel.resolveRuns() and then read the answers back out to bake a
    // closure. Both are gone -- the kernel decides in init(), where the
    // pipeline, the LUT and the settled lutMode are all final.

    test('create() alone settles the image path (RGB→RGB float)', () => {
        const t = new Transform({ buildLut: true, lutMode: 'float' });
        t.create('*srgb', '*adobergb', eIntent.relative);

        expect(t.kernel.arrayFnBig).not.toBeNull();
        expect(t.kernel.arrayFnSml).not.toBeNull();
        expect(t.kernel.arrayFnBigName).toBe('fl_3_3');       // float mode wins outright
        expect(t.kernel.arrayFnSmlName).toBe('fl_3_3');
        expect(t.kernel.threshold).toBe(0);                   // collapsed → no per-call branch
    });

    test('RGB→RGB int lands on the integer run', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int' });
        t.create('*srgb', '*adobergb', eIntent.relative);
        expect(t.kernel.arrayFnBigName).toBe('i_3_3');
        expect(t.kernel.arrayFnSmlName).toBe('i_3_3');
        expect(t.kernel.threshold).toBe(0);
    });

    test('Transform has no dispatch state of its own', () => {
        // The three fields it used to hold, and the two methods that
        // maintained them. If any of these comes back, dispatch has leaked
        // back out of the kernel.
        const t = new Transform({ buildLut: true, lutMode: 'float' });
        t.create('*srgb', '*adobergb', eIntent.relative);
        expect(t._lutKernelBig).toBeUndefined();
        expect(t._lutKernelSmall).toBeUndefined();
        expect(t._lutKernelThreshold).toBeUndefined();
        expect(t._resolveLutKernels).toBeUndefined();
        expect(t._bindLutTransformArrayFn).toBeUndefined();
        expect(t.kernel.resolveRuns).toBeUndefined();
    });

    test('1-D and 2-D kernels have nothing to resolve, and no init() to do it in', () => {
        // One implementation each, called directly by array(). No virtual gray
        // profile exists in createVirtualProfile(), so fake the post-create()
        // shape -- setKernel() picks the kernel by dimension.
        for(const dims of [1, 2]){
            const t = new Transform({ buildLut: true, lutMode: 'float' });
            t.lut = { inputChannels: dims, outputChannels: 3, intLut: null };
            t.setKernel(dims);
            expect(t.kernel.init).toBeUndefined();
            expect(t.kernel.arrayFnBig).toBeNull();
            expect(t.kernel.arrayFnSml).toBeNull();
            expect(t.kernel.arrayFnBigName).toBeNull();
        }
    });

    if(HAS_WASM){
        test('WASM mode → the kernel keeps a threshold, and keeps it to itself', () => {
            const t = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar' });
            t.create('*srgb', '*adobergb', eIntent.relative);
            expect(t.lutMode).toBe('int-wasm-scalar');       // not demoted
            expect(t.wasmTetra3D).not.toBeNull();
            expect(t.kernel.arrayFnBigName).toBe('i8ws_3_3');
            expect(t.kernel.arrayFnSmlName).toBe('i_3_3');
            expect(t.kernel.threshold).toBe(Transform.WASM_DISPATCH_MIN_PIXELS);
        });

        test('releasing WASM makes the kernel re-decide, not Transform', () => {
            // releaseWasmMemory() used to re-run Transform's resolver. Now it
            // drops the states and clears the kernel's path; the kernel
            // resolves again on the next array(), with the slots empty, and
            // lands on the JS variant by its own ladder.
            const t = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar' });
            t.create('*srgb', '*adobergb', eIntent.relative);
            expect(t.kernel.arrayFnBigName).toBe('i8ws_3_3');

            t.releaseWasmMemory();
            expect(t.kernel.arrayFnBig).toBeNull();

            const px = 4096;
            const out = t.transformArray(new Uint8ClampedArray(px * 3), false, false, false, px);
            expect(out.length).toBe(px * 3);
            expect(t.kernel.arrayFnBigName).toBe('i_3_3');   // degraded to JS, on its own
        });
    }
});
