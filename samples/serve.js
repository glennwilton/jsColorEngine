/*
 * samples/serve.js
 * =================
 *
 * Tiny zero-dependency static HTTP server for the sample / demo pages.
 *
 * Document root is the repo root so relative URLs like
 *   /browser/jsColorEngineWeb.js
 *   /samples/profiles/CoatedGRACoL2006.icc
 *   /samples/bench/                        (browser performance bench)
 * all resolve naturally.
 *
 * Usage:
 *   node samples/serve.js              # default port 8080
 *   node samples/serve.js --port=9000  # custom port
 *
 * npm shortcut:
 *   npm run serve
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const REPO_ROOT = path.resolve(__dirname, '..');

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
    '.mp4':  'video/mp4',
    '.webm': 'video/webm',
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
            '  Build it:     npm run browser\n'
        );
    }
    const profileDir = path.join(REPO_ROOT, 'samples', 'profiles');
    const profiles = fs.existsSync(profileDir)
        ? fs.readdirSync(profileDir).filter(f => /\.icc$/i.test(f))
        : [];
    if (profiles.length === 0) {
        errors.push(
            'No ICC profiles found in samples/profiles/\n' +
            '  Drop at least one CMYK .icc file there (e.g. CoatedGRACoL2006.icc).\n'
        );
    } else {
        console.log(' profiles         : ' + profiles.join(', '));
    }
    const lcmsJs   = path.join(REPO_ROOT, 'samples', 'lcms-wasm-dist', 'lcms.js');
    const lcmsWasm = path.join(REPO_ROOT, 'samples', 'lcms-wasm-dist', 'lcms.wasm');
    if (!fs.existsSync(lcmsJs) || !fs.existsSync(lcmsWasm)) {
        errors.push(
            'Missing lcms-wasm:  samples/lcms-wasm-dist/lcms.js and lcms.wasm\n' +
            '  Copy the dist/ output from the lcms-wasm package into that folder.\n'
        );
    } else {
        console.log(' lcms-wasm-dist   : OK');
    }
    if (errors.length) {
        console.error('\n[samples] pre-flight FAILED:\n');
        for (const e of errors) console.error('  ' + e.replace(/\n/g, '\n  '));
        process.exit(1);
    }
}

// --- server --------------------------------------------------------------

function safeJoin(root, requestedPath) {
    const decoded = decodeURIComponent(requestedPath);
    const joined  = path.normalize(path.join(root, decoded));
    if (!joined.startsWith(root)) return null;
    return joined;
}

function serveFile(filePath, res) {
    fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) {
            res.statusCode = 404;
            res.end('Not Found');
            return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type',  mimeFor(filePath));
        res.setHeader('Content-Length', st.size);
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy',  'require-corp');
        res.setHeader('Cross-Origin-Resource-Policy',   'cross-origin');
        fs.createReadStream(filePath).pipe(res);
    });
}

function handle(req, res) {
    const parsed = url.parse(req.url);
    let p = parsed.pathname || '/';

    if (p === '/' || p === '/samples') {
        res.statusCode = 302;
        res.setHeader('Location', '/samples/');
        res.end();
        return;
    }
    if (p === '/samples/') {
        p = '/samples/index.html';
    }

    // Legacy site URLs -> current bench path
    if (p === '/bench/browser' || p === '/bench/browser/') {
        res.statusCode = 302;
        res.setHeader('Location', '/samples/bench/');
        res.end();
        return;
    }

    // Browser bench: redirect to a trailing slash so module-relative script URLs resolve
    if (p === '/samples/bench') {
        res.statusCode = 302;
        res.setHeader('Location', '/samples/bench/');
        res.end();
        return;
    }
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
    console.log(' jsColorEngine samples');
    console.log('================================================================');
    console.log(' serving repo root: ' + REPO_ROOT);
    console.log(' samples          : http://localhost:' + port + '/samples/');
    console.log(' bench            : http://localhost:' + port + '/samples/bench/');
    console.log(' stop server      : Ctrl+C');
    console.log('');
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error('Port ' + port + ' already in use. Try:');
        console.error('  node samples/serve.js --port=' + (port + 1));
        process.exit(1);
    }
    throw err;
});
