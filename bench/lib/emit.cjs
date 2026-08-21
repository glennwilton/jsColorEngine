/**
 * bench/lib/emit.cjs — benches write their own JSON as they go.
 *
 * WHY THIS EXISTS. Every throughput figure in the docs used to be transcribed
 * by hand out of console output, which is how one page ends up carrying two
 * vintages of the same number. A bench that emits structured rows can feed a
 * generated results page instead, and `scripts/build_bench_results.js` renders
 * exactly what was measured.
 *
 * SILENT BY DEFAULT. With no `JSCE_BENCH_JSON` in the environment every call
 * here is a no-op, so a bench run by hand behaves exactly as it did before and
 * console output stays the authority for a human reading along.
 *
 *   JSCE_BENCH_JSON=/path/out.json node bench/whatever.js
 *
 * The file is written once on process exit, so a bench that dies half way
 * leaves no half-truth behind.
 *
 * Usage:
 *     const emit = require('../lib/emit.cjs');
 *     emit.meta({ workflow: 'rgb2cmyk' });
 *     emit.table({
 *         id: 'js.content.rgb2cmyk',
 *         title: 'RGB -> CMYK, 1M px',
 *         units: 'MPx/s',
 *         columns: ['content', 'jsceSimd', 'lcmsWasm'],
 *         rows: [{ content: 'photo', jsceSimd: 122.5, lcmsWasm: 35.1 }],
 *     });
 */
'use strict';

const OUT = process.env.JSCE_BENCH_JSON || null;

// The engine version is stamped on every run, not just noted in a heading:
// a table is only trustworthy against the code that produced it, and a page
// that quotes one needs a way to notice the code has moved on since.
function packageVersion() {
    try {
        return require(require('path').join(__dirname, '..', '..', 'package.json')).version;
    } catch (e) { return null; }
}

const doc = {
    tool:      null,                       // set from argv[1] on first use
    generated: new Date().toISOString(),
    node:      process.version,
    platform:  process.platform + ' ' + process.arch,
    meta:      { jsce: packageVersion() },
    tables:    [],
};

let armed = false;

function arm() {
    if (armed || !OUT) return;
    armed = true;
    const path = require('path');
    doc.tool = path.relative(process.cwd(), process.argv[1] || '?')
        .split(path.sep).join('/');
    process.on('exit', save);
}

/** Merge facts that describe the whole run — profiles, corpus, versions. */
function meta(obj) {
    if (!OUT) return;
    arm();
    Object.assign(doc.meta, obj || {});
}

/**
 * One table. `id` is the handle the docs cite, so keep it stable across runs —
 * renaming one silently orphans whatever quotes it.
 */
function table(t) {
    if (!OUT) return;
    arm();
    if (!t || !t.id) throw new Error('emit.table: an id is required — the docs cite it');
    doc.tables.push({
        id:      t.id,
        title:   t.title || t.id,
        units:   t.units || null,
        meta:    t.meta || {},
        columns: t.columns || (t.rows && t.rows[0] ? Object.keys(t.rows[0]) : []),
        rows:    t.rows || [],
    });
}

function save() {
    if (!OUT || !doc.tables.length) return;
    const fs = require('fs'), path = require('path');
    try {
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
    } catch (e) {
        // A bench must never fail because bookkeeping failed.
        process.stderr.write('emit: could not write ' + OUT + ' — ' + e.message + '\n');
    }
}

module.exports = { meta, table, save, enabled: !!OUT };
