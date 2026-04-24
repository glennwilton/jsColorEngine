// ============================================================================
// compile_wasm.js — dev-time pre-compiler for shipping .wat kernels
// ============================================================================
//
// Reads each .wat file in src/wasm/ and emits a sibling .wasm.js CommonJS
// module exporting the binary bytes as a base64-decoded Uint8Array.
//
// Why base64-in-JS rather than shipping raw .wasm:
// - Works in Node, browsers, bundlers (webpack / rollup / esbuild) without
//   any loader configuration — it's just a .js file that a require() picks up.
// - Kernel is ~1.8 KB .wasm → ~2.4 KB base64 → ~50 bytes overhead once gzipped.
// - Zero runtime dependency on wabt.
// - Zero async / fetch() at Transform.create() time.
//
// Re-run this script whenever a .wat in src/wasm/ changes:
//   node bench/wasm_poc/compile_wasm.js
//
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const wabtFactory = require('wabt');

const WASM_SRC_DIR = path.join(__dirname, '..', '..', 'src', 'wasm');

async function compileOne(wabt, watPath) {
    const watName = path.basename(watPath);
    const wat = fs.readFileSync(watPath, 'utf8');
    const mod = wabt.parseWat(watName, wat, { multi_value: true, mutable_globals: true });
    const { buffer } = mod.toBinary({});
    mod.destroy();

    const bytes = Buffer.from(buffer);
    const base64 = bytes.toString('base64');
    const outPath = watPath.replace(/\.wat$/, '.wasm.js');

    const js = [
        '// ============================================================================',
        `// ${path.basename(outPath)} — AUTO-GENERATED from ${watName}`,
        '// ============================================================================',
        '//',
        '// Do not edit by hand. Regenerate with:',
        '//   node bench/wasm_poc/compile_wasm.js',
        '//',
        `// Source:  src/wasm/${watName}`,
        `// Size:    ${bytes.length} bytes .wasm`,
        '// ============================================================================',
        '',
        "'use strict';",
        '',
        '// Base64-encoded WebAssembly module bytes. Decoded once at module-load',
        '// time into a Uint8Array, which is what WebAssembly.compile / .Module',
        '// expects. Works identically in Node and browser (atob fallback for',
        '// environments where Buffer is absent).',
        `const BASE64 = '${base64}';`,
        '',
        'function decode(b64) {',
        "    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {",
        "        return new Uint8Array(Buffer.from(b64, 'base64'));",
        '    }',
        "    if (typeof atob === 'function') {",
        '        const bin = atob(b64);',
        '        const out = new Uint8Array(bin.length);',
        '        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);',
        '        return out;',
        '    }',
        "    throw new Error('No base64 decoder available (need Buffer or atob).');",
        '}',
        '',
        'module.exports = decode(BASE64);',
        ''
    ].join('\n');

    fs.writeFileSync(outPath, js);
    return { watPath, outPath, bytes: bytes.length, base64: base64.length };
}

async function main() {
    const wabt = await wabtFactory();
    const entries = fs.readdirSync(WASM_SRC_DIR)
        .filter(f => f.endsWith('.wat'))
        .map(f => path.join(WASM_SRC_DIR, f));

    if (entries.length === 0) {
        console.log('No .wat files found in', WASM_SRC_DIR);
        return;
    }

    console.log('Compiling', entries.length, '.wat file(s):');
    for (const wat of entries) {
        const r = await compileOne(wabt, wat);
        const wasmRel = path.relative(process.cwd(), r.outPath);
        console.log('  ', path.basename(wat).padEnd(24), '→', wasmRel.padEnd(40), `${r.bytes}B wasm / ${r.base64}B base64`);
    }
    console.log('');
    console.log('Done.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
