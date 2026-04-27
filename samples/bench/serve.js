/*
 * samples/bench/serve.js
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
 *   node samples/bench/serve.js              # default port 8080
 *   node samples/bench/serve.js --port=9000  # custom port
 *
 * The server's document root is the repo root, so relative URLs like
 *   /browser/jsColorEngineWeb.js
 *   /samples/lcms-wasm-dist/lcms.wasm
 *   /samples/profiles/CoatedGRACoL2006.icc
 * all resolve naturally without any copying or symlinking.
 *
 * Prefer the unified dev server (same port for samples + bench):
 *   npm run serve
 *
 * Pre-flight checks:
 *   - browser/jsColorEngineWeb.js exists  (built via `npm run browser`)
 *   - samples/lcms-wasm-dist/lcms.js + lcms.wasm
 *   - samples/profiles/CoatedGRACoL2006.icc and AdobeRGB1998.icc
 * The script prints a friendly error pointing at the fix if any is missing.
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
            '                edit samples/bench/index.html to point at browser-dev/)\n'
        );
    }
    const lcmsJs   = path.join(REPO_ROOT, 'samples', 'lcms-wasm-dist', 'lcms.js');
    const lcmsWasm = path.join(REPO_ROOT, 'samples', 'lcms-wasm-dist', 'lcms.wasm');
    if (!fs.existsSync(lcmsJs) || !fs.existsSync(lcmsWasm)) {
        errors.push(
            'Missing lcms-wasm:  samples/lcms-wasm-dist/lcms.js and lcms.wasm\n' +
            '  Copy the dist/ output from the lcms-wasm npm package, or run\n' +
            '  `npm pack lcms-wasm` and extract dist/ into that folder.\n'
        );
    }
    const gracol = path.join(REPO_ROOT, 'samples', 'profiles', 'CoatedGRACoL2006.icc');
    const adobe  = path.join(REPO_ROOT, 'samples', 'profiles', 'AdobeRGB1998.icc');
    if (!fs.existsSync(gracol) || !fs.existsSync(adobe)) {
        errors.push(
            'Missing ICC profiles in samples/profiles/:\n' +
            '  - CoatedGRACoL2006.icc (GRACoL CMYK)\n' +
            '  - AdobeRGB1998.icc (non-identity RGB\u2194RGB for the bench)\n'
        );
    }
    if (errors.length) {
        console.error('\n[samples/bench] pre-flight FAILED:\n');
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

    // Redirect '/' and '/samples/bench' (no trailing slash) to the
    // bench index with a trailing slash. Doing this as a 302 (not just
    // silently serving the HTML) is important: the browser's "base URL"
    // for resolving relative hrefs/srcs in the page is the URL in the
    // address bar, not whatever file we happen to return. Without the
    // redirect, '/styles.css' and '/main.js' would 404 because the
    // browser would resolve them against '/'.
    if (p === '/' || p === '/samples/bench') {
        res.statusCode = 302;
        res.setHeader('Location', '/samples/bench/');
        res.end();
        return;
    }
    // Serve the index.html for the directory URL itself.
    if (p === '/samples/bench/') {
        p = '/samples/bench/index.html';
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
    console.log(' jsColorEngine browser bench (standalone server)');
    console.log('================================================================');
    console.log(' serving repo root: ' + REPO_ROOT);
    console.log(' open in browser  : http://localhost:' + port + '/samples/bench/');
    console.log(' (unified dev server: npm run serve)');
    console.log(' stop server      : Ctrl+C');
    console.log('');
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error('Port ' + port + ' already in use. Try:');
        console.error('  node samples/bench/serve.js --port=' + (port + 1));
        process.exit(1);
    }
    throw err;
});
