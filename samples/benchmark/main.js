// main.js
//
// Entry point. Wires the engine, UI, resource pool, and group runner together.
// Same file works in Node and the browser (with appropriate bundling).
//
// Profiles and engine references are loaded by environment-specific loaders
// (loaders/nodeLoader.js or loaders/webLoader.js) so this file stays portable.

import { resources }   from './shared-resources.js';
import { BenchEngine } from './bench-engine.js';
import { GroupRunner } from './group-runner.js';
import { ConsoleUI }   from './console-ui.js';

// Register groups (side-effect imports)
import './groups/baseline.js';
import './groups/lcms.js';
import './groups/jsce.js';
import './groups/v5-experimental.js';

import { setEngine as setJsceEngine } from './groups/jsce.js';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

export async function runBench(options = {}) {
    const {
        groupIds         = ['baseline', 'jsce'],
        // Quick mode is the default — fast enough for development iteration.
        // Pass --full from CLI (or override here) for production benchmark runs.
        // timedRuns = iterations per batch; timedBatches = number of batches.
        pixelCounts      = [32_768, 65_536, 1_000_000],
        warmupRuns       = 200,   // matches old bench — V8 fully TurboFan-compiled before timing
        timedRuns        = 50,    // iters per batch — amortizes performance.now() timer overhead
        timedBatches     = 5,
        skipWarmup       = false,
        runBaselineTwice = true,
        seed             = 0x12345678,
    } = options;

    // 1. Load environment resources (profiles + engine references)
    const loaderPath = isNode ? './loaders/nodeLoader.js' : './loaders/webLoader.js';
    const { load } = await import(loaderPath);
    const { profiles, jsce } = await load();

    // 2. Inject engines into groups before groups are loaded
    setJsceEngine(jsce, profiles);

    // 3. Pixel buffer pool
    await resources.initialize({ seed, pixelCounts });

    // 4. UI
    const ui = new ConsoleUI({ verbose: true });

    // 5. Bench engine
    const engine = new BenchEngine({
        pixelCounts,
        warmupRuns,
        timedRuns,
        timedBatches,
        resources,
        onProgress: (e) => ui.onProgress(e),
    });

    // 6. Runner
    const runner = new GroupRunner(engine);

    console.log('=== Benchmark Suite v0.1 ===\n');
    const output = await runner.runGroups(groupIds, { skipWarmup, runBaselineTwice });

    ui.setHardware(output.hardware);
    ui.printSummary(output);

    return output;
}

// Auto-run when invoked directly in Node.
//
//   node main.js               — quick (warmup×10, timed×10, 32K/64K/1M px)
//   node main.js --full        — production (warmup×200, timed×50, all 4 sizes)
//   node main.js --skip-warmup — skip 5s CPU preheat (works with both modes)
if (isNode && process.argv?.[1]?.endsWith('main.js')) {
    const args        = process.argv.slice(2);
    const isFull      = args.includes('--full');
    const skipWarmup  = args.includes('--skip-warmup');

    runBench({
        skipWarmup,
        warmupRuns:   isFull ? 200 : 10,
        timedRuns:    50,   // iters per batch — same in both modes
        timedBatches: isFull ? 10 : 5,
        pixelCounts:  isFull ? [32_768, 65_536, 1_000_000, 10_000_000] : [32_768, 65_536, 1_000_000],
    }).catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
