// groups/baseline.js
//
// Built-in baselines. No external dependencies.
// Overhead, memory copy variants, CPU compute.

import { BenchmarkGroup, groups } from '../benchmark-groups.js';

// =============================================================================
// WASM bytecode helpers
// =============================================================================

// WASM module that exposes `memory.copy` as the function `copy(dst, src, len)`
// and exports its memory. 128 pages = 8 MB linear memory.
//
// WAT equivalent:
//   (module
//     (memory (export "memory") 128)
//     (func (export "copy") (param i32 i32 i32)
//       local.get 0
//       local.get 1
//       local.get 2
//       memory.copy))
const WASM_MEMORY_COPY = new Uint8Array([
    // Magic + version
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    // Type section: (i32, i32, i32) -> ()
    0x01, 0x07, 0x01, 0x60, 0x03, 0x7f, 0x7f, 0x7f, 0x00,
    // Function section: 1 function, type 0
    0x03, 0x02, 0x01, 0x00,
    // Memory section: 1 memory, min=128 pages (8 MB). 128 in LEB128 = 0x80 0x01 (2 bytes) → section size 4.
    0x05, 0x04, 0x01, 0x00, 0x80, 0x01,
    // Export section: "memory" (memory 0), "copy" (func 0)
    0x07, 0x11, 0x02,
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
    0x04, 0x63, 0x6f, 0x70, 0x79, 0x00, 0x00,
    // Code section: 1 function body = 0 locals + local.get 0,1,2 + memory.copy + end (12 bytes)
    //   section size = count(1) + body_size_prefix(1) + body(12) = 14 = 0x0e
    //   body size = locals(1) + local.get×3(6) + memory.copy(4) + end(1) = 12 = 0x0c
    0x0a, 0x0e, 0x01, 0x0c, 0x00,
    0x20, 0x00, 0x20, 0x01, 0x20, 0x02,
    0xfc, 0x0a, 0x00, 0x00,
    0x0b,
]);

// NOTE TO FUTURE ME:
// The hand-coded bytecode above for memory.copy needs verification before
// shipping. If WebAssembly.compile() rejects it, use wabt.js or wat2wasm
// to compile the WAT shown in the comment, then paste fresh bytes.
// SIMD copy and WASM primes are not yet implemented — see TODOs below.

async function compileWasm(bytes) {
    const mod = await WebAssembly.compile(bytes);
    return WebAssembly.instantiate(mod, {});
}

// =============================================================================
// Group definition
// =============================================================================

const baselineGroup = new BenchmarkGroup({
    id:          'baseline',
    name:        'Hardware Baselines',
    description: 'Overhead, memory bandwidth, and CPU compute baselines',
    tags:        ['baseline', 'required'],

    loader: async (group) => {
        // ---- Overhead -----------------------------------------------------

        group.register({
            id:     'overhead-noop',
            name:   'overhead-noop',
            tags:   ['overhead'],
            metric: 'none',    // no data moved — MPx/s would be meaningless
            setup:     (input, output) => ({}),
            transform: (ctx, input, output) => { /* intentionally empty */ },
        });

        // ---- Memory: JS ---------------------------------------------------

        group.register({
            id:     'mem-js-set',
            name:   'mem-js-set',
            tags:   ['memory', 'js'],
            metric: 'mbps',
            setup:     (input, output) => ({}),
            transform: (ctx, input, output) => { output.set(input); },
        });

        group.register({
            id:     'mem-js-loop',
            name:   'mem-js-loop',
            tags:   ['memory', 'js'],
            metric: 'mbps',
            setup:     (input, output) => ({}),
            transform: (ctx, input, output) => {
                const len = input.length;
                for (let i = 0; i < len; i++) output[i] = input[i];
            },
        });

        group.register({
            id:     'mem-js-uint32',
            name:   'mem-js-uint32',
            tags:   ['memory', 'js'],
            metric: 'mbps',
            setup: (input, output) => {
                // Pre-create aligned views once. (Setup is excluded from timing.)
                const len32 = Math.floor(input.length / 4);
                return {
                    in32:  new Uint32Array(input.buffer,  input.byteOffset,  len32),
                    out32: new Uint32Array(output.buffer, output.byteOffset, len32),
                    tailStart: len32 * 4,
                };
            },
            transform: (ctx, input, output) => {
                ctx.out32.set(ctx.in32);
                for (let i = ctx.tailStart; i < input.length; i++) output[i] = input[i];
            },
        });

        // ---- Memory: WASM -------------------------------------------------

        // Uses memory.copy. This is our "peak" — hardware-optimized memcpy.
        // Benchmark measures the full round-trip: JS→WASM copy-in, memory.copy within
        // WASM linear memory, then copy-out back to JS. This is the best-case
        // throughput achievable when WASM processes data from shared JS buffers.
        group.register({
            id:     'mem-wasm-bulk',
            name:   'mem-wasm-bulk',
            tags:   ['memory', 'wasm', 'peak'],
            metric: 'mbps',
            setup: async (input) => {
                const inst = await compileWasm(WASM_MEMORY_COPY);
                const exports = (inst.instance || inst).exports;
                // Ensure WASM memory can hold two copies of the input (src + dst regions).
                // Default 128 pages = 8 MB; 10 M RGB pixels needs 60 MB.
                const neededBytes  = input.length * 2;
                const currentBytes = exports.memory.buffer.byteLength;
                if (neededBytes > currentBytes) {
                    const extraPages = Math.ceil((neededBytes - currentBytes) / 65536);
                    exports.memory.grow(extraPages);
                }
                return { exports };
            },
            transform: (ctx, input, output) => {
                // Re-read memory.buffer each call — grow() detaches the old ArrayBuffer.
                const mem = new Uint8Array(ctx.exports.memory.buffer);
                mem.set(input, 0);
                ctx.exports.copy(input.length, 0, input.length);
                output.set(mem.subarray(input.length, input.length * 2));
            },
        });

        // TODO future-me:
        //   mem-wasm-simd  — v128.load / v128.store loop, 16 bytes/iter
        //   mem-wasm-scalar — i32.load8_u / i32.store8 loop
        // Skip for now to keep bytecode simple; add once mem-wasm-bulk is verified working.

        // ---- CPU ----------------------------------------------------------

        group.register({
            id:     'cpu-primes-js',
            name:   'cpu-primes-js',
            tags:   ['cpu', 'js'],
            metric: 'ops',    // reports runs/sec (1 run = one sieve to 100K), not pixels
            setup: (input, output) => ({
                limit: 100_000,                      // small enough for sub-millisecond timing
                out: output || new Uint8Array(4),
            }),
            transform: (ctx) => {
                const sieve = new Uint8Array(ctx.limit);
                let count = 0;
                for (let i = 2; i < ctx.limit; i++) {
                    if (sieve[i] === 0) {
                        count++;
                        for (let j = i + i; j < ctx.limit; j += i) sieve[j] = 1;
                    }
                }
                ctx.out[0] = count & 0xFF;
                ctx.out[1] = (count >> 8) & 0xFF;
            },
        });

        // TODO future-me:
        //   cpu-primes-wasm — same algorithm, compiled to WASM
        //   cpu-matmul-js   — 256x256 FP matrix multiply
    },
});

groups.register(baselineGroup);
export { baselineGroup };