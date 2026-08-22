// Compile a kernel .wat next to itself as .wasm.js (base64 Uint8Array).
// Tetra kernels with ;;Inject:* anchors also get interp_*_cached (single-entry).
'use strict';

const fs = require('fs');
const path = require('path');
const wabtFactory = require('wabt');
const paired = require('../bench/pixel_cache_wasm/build_paired.js');

async function compileOne(wabt, watPath){
    const watName = path.basename(watPath);
    let wat = fs.readFileSync(watPath, 'utf8');
    const spec = paired.kernelForWat(watPath);
    let cachedExport = '';
    if(spec && wat.indexOf(paired.INJECT.localsAfter) >= 0){
        wat = paired.injectSingleEntryWat(wat, spec);
        cachedExport = spec.export + '_cached';
    }
    const features = { multi_value: true, mutable_globals: true };
    if(spec && (spec.kind.startsWith('simd') || spec.key === 'rgb')) features.simd = true;
    const mod = wabt.parseWat(watName, wat, features);
    const { buffer } = mod.toBinary({});
    mod.destroy();
    const bytes = Buffer.from(buffer);
    const base64 = bytes.toString('base64');
    const outPath = watPath.replace(/\.wat$/, '.wasm.js');
    const relSrc = path.relative(path.join(__dirname, '..'), watPath).replace(/\\/g, '/');
    const gen = spec && spec.dim >= 5
        ? 'node scripts/gen_tetra56_nch.js && node scripts/compile_kernel_wat.js ' + relSrc
        : 'node scripts/compile_kernel_wat.js ' + relSrc;
    const extra = cachedExport
        ? '// Exports: ' + spec.export + ' (verbatim) + ' + cachedExport + ' (single-entry).\n'
        : '';
    const js = [
        '/*************************************************************************',
        ' *  @license',
        ' *',
        ' *  Copyright © 2019, 2026 Glenn Wilton',
        ' *  O2 Creative Limited',
        ' *************************************************************************/',
        '',
        '// ============================================================================',
        `// ${path.basename(outPath)} — AUTO-GENERATED from ${watName}`,
        '// ============================================================================',
        '//',
        '// Do not edit by hand. Regenerate with:',
        '//   ' + gen,
        '//',
        extra +
        `// Source:  ${relSrc}`,
        `// Size:    ${bytes.length} bytes .wasm`,
        '// ============================================================================',
        '',
        "'use strict';",
        '',
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
    return { outPath, bytes: bytes.length, cachedExport };
}

async function main(){
    const files = process.argv.slice(2);
    if(!files.length){
        console.error('usage: node scripts/compile_kernel_wat.js <file.wat>...');
        process.exit(1);
    }
    const wabt = await wabtFactory();
    for(const f of files){
        const r = await compileOne(wabt, path.resolve(f));
        console.log(path.basename(f), '→', path.relative(process.cwd(), r.outPath), r.bytes + 'B'
            + (r.cachedExport ? ' + ' + r.cachedExport : ''));
    }
}

main().catch(function(err){
    console.error(err);
    process.exit(1);
});
