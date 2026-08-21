/**
 * Pull a specific version's browser bundle from git history into bench/archive/.
 *
 * Usage:
 *   node scripts/pull-bundle.js 1.4.4
 *   npm run archive 1.4.4
 *
 * The browser bundle must be committed at the given tag (or SHA).
 * bench/archive/ is gitignored — local only.
 */

'use strict';

const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');

const versionArg = process.argv[2];
if(!versionArg){
    console.error('Usage: node scripts/pull-bundle.js <version>   e.g. 1.4.4');
    process.exit(1);
}

// SHA hashes (7+ hex chars): use as-is. Version numbers: prepend 'v'.
const isSha       = /^[0-9a-f]{7,40}$/.test(versionArg);
const tag         = isSha ? versionArg : (versionArg.startsWith('v') ? versionArg : 'v' + versionArg);
const fileLabel   = isSha ? versionArg.slice(0, 7) : tag;
const archiveDir  = path.join(__dirname, '..', 'bench', 'archive');
const outputFile  = path.join(archiveDir, 'jsColorEngineWeb_' + fileLabel + '.js');

fs.mkdirSync(archiveDir, { recursive: true });

try {
    const content = execSync('git show ' + tag + ':browser/jsColorEngineWeb.js', { encoding: 'utf8' });
    fs.writeFileSync(outputFile, content);
    console.log('saved → ' + path.relative(process.cwd(), outputFile));
} catch (error) {
    console.error('Failed — is "' + tag + '" a valid git tag or SHA?');
    console.error('Available tags:');
    console.error(execSync('git tag --list "v*"', { encoding: 'utf8' }).trim() || '  (none)');
    process.exit(1);
}
