/*
 * bench/browser/serve.js
 * ======================
 *
 * Tiny zero-dependency static HTTP server for the browser bench.
 *
 * Why we need a server (and can't just open the .html with file://):
 *   - browsers block fetch() of local files via file://
 *   - WebAssembly.instantiateStreaming(fetch(...)) needs application/wasm MIME
 *   - the lcms-wasm package fetches its .wasm sibling at runtime
 *   - jsColorEngine's Profile.loadURL() uses XHR/fetch
 *
 * Usage:
 *   node bench/browser/serve.js              # default port 8080
 *   node bench/browser/serve.js --port=9000  # custom port
 *
 * The server's document root is the repo root, so relative URLs like
 *   /browser/jsColorEngineWeb.js
 *   /bench/lcms-comparison/node_modules/lcms-wasm/dist/lcms.wasm
 *   /__tests__/GRACoL2006_Coated1v2.icc
 * all resolve naturally without any copying or symlinking.
 *
 * Pre-flight checks:
 *   - browser/jsColorEngineWeb.js exists  (built via `npm run browser`)
 *   - lcms-wasm package present           (installed via the bench/lcms-comparison sub-package)
 * The script prints a friendly error pointing at the fix if either is missing.
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// --- args ----------------------------------------------------------------

let port = 8080;
for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--port=(\d+)$/);
    if (m) port = parseInt(m[1], 10);
}

// --- mime ----------------------------------------------------------------

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.htm':  'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.ico':  'image/x-icon',
    '.wasm': 'application/wasm',
    '.icc':  'application/vnd.iccprofile',
    '.icm':  'application/vnd.iccprofile',
    '.map':  'application/json; charset=utf-8',
    '.txt':  'text/plain; charset=utf-8',
    '.md':   'text/plain; charset=utf-8',
};

function mimeFor(p) {
    return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

// --- pre-flight ----------------------------------------------------------

function preflight() {
    const errors = [];
    const umd = path.join(REPO_ROOT, 'browser', 'jsColorEngineWeb.js');
    if (!fs.existsSync(umd)) {
        errors.push(
            'Missing build:  browser/jsColorEngineWeb.js\n' +
            '  Build it:     npm run browser\n' +
            '                (production UMD bundle)\n' +
            '  or for dev:   npm run browser-watch\n' +
            '                (writes to browser-dev/ with sourcemaps; you must then\n' +
            '                edit bench/browser/index.html to point at browser-dev/)\n'
        );
    }
    const lcmsJs   = path.join(REPO_ROOT, 'bench', 'lcms-comparison', 'node_modules', 'lcms-wasm', 'dist', 'lcms.js');
    const lcmsWasm = path.join(REPO_ROOT, 'bench', 'lcms-comparison', 'node_modules', 'lcms-wasm', 'dist', 'lcms.wasm');
    if (!fs.existsSync(lcmsJs) || !fs.existsSync(lcmsWasm)) {
        errors.push(
            'Missing lcms-wasm:  bench/lcms-comparison/node_modules/lcms-wasm/\n' +
            '  Install it:       cd bench/lcms-comparison && npm install\n' +
            '                    (it lives in a sub-package so the main jsColorEngine\n' +
            '                     install stays light)\n'
        );
    }
    const profile = path.join(REPO_ROOT, '__tests__', 'GRACoL2006_Coated1v2.icc');
    if (!fs.existsSync(profile)) {
        errors.push(
            'Missing profile:  __tests__/GRACoL2006_Coated1v2.icc\n' +
            '  This file ships in the repo. If it is missing the working copy is\n' +
            '  incomplete \u2014 try `git status` and `git checkout`.\n'
        );
    }
    if (errors.length) {
        console.error('\n[bench/browser] pre-flight FAILED:\n');
        for (const e of errors) console.error('  ' + e.replace(/\n/g, '\n  '));
        process.exit(1);
    }
}

// --- server --------------------------------------------------------------

function safeJoin(root, requestedPath) {
    // Resolve, then verify the result is still inside root. Defends against
    // ../../../etc/passwd-style traversal even though browsers don't normally
    // emit those.
    const decoded = decodeURIComponent(requestedPath);
    const joined  = path.normalize(path.join(root, decoded));
    if (!joined.startsWith(root)) return null;
    return joined;
}

function serveFile(filePath, res) {
    fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) {
            res.statusCode = 404;
            res.end('Not Found: ' + filePath);
            return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type',  mimeFor(filePath));
        res.setHeader('Content-Length', st.size);
        res.setHeader('Cache-Control', 'no-cache');
        // Cross-Origin isolation headers for SharedArrayBuffer / threading;
        // cheap to add and doesn't hurt the single-threaded path.
        res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        fs.createReadStream(filePath).pipe(res);
    });
}

function handle(req, res) {
    const parsed = url.parse(req.url);
    let p = parsed.pathname || '/';

    // Redirect '/' and '/bench/browser' (no trailing slash) to the
    // bench index with a trailing slash. Doing this as a 302 (not just
    // silently serving the HTML) is important: the browser's "base URL"
    // for resolving relative hrefs/srcs in the page is the URL in the
    // address bar, not whatever file we happen to return. Without the
    // redirect, '/styles.css' and '/main.js' would 404 because the
    // browser would resolve them against '/'.
    if (p === '/' || p === '/bench/browser') {
        res.statusCode = 302;
        res.setHeader('Location', '/bench/browser/');
        res.end();
        return;
    }
    // Serve the index.html for the directory URL itself.
    if (p === '/bench/browser/') {
        p = '/bench/browser/index.html';
    }

    const filePath = safeJoin(REPO_ROOT, p);
    if (!filePath) {
        res.statusCode = 400;
        res.end('Bad path');
        return;
    }
    serveFile(filePath, res);
}

// --- main ----------------------------------------------------------------

preflight();

const server = http.createServer(handle);
server.listen(port, () => {
    console.log('================================================================');
    console.log(' jsColorEngine browser bench');
    console.log('================================================================');
    console.log(' serving repo root: ' + REPO_ROOT);
    console.log(' open in browser  : http://localhost:' + port + '/');
    console.log(' stop server      : Ctrl+C');
    console.log('');
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error('Port ' + port + ' already in use. Try:');
        console.error('  node bench/browser/serve.js --port=' + (port + 1));
        process.exit(1);
    }
    throw err;
});
