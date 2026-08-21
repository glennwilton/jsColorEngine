/**
 * scripts/lib/machine.js — a stable identity for the box a bench ran on.
 *
 * WHY THIS EXISTS. Throughput is a property of the machine at least as much as
 * of the code. A Ryzen 7700X and an M2 mini disagree by more than any refactor
 * this project will ever make, so a baseline is only a control for the machine
 * that produced it. Comparing across machines without saying so produces a wall
 * of "regressions" that are really just a different CPU — which trains people
 * to ignore the tool.
 *
 * So every stored run is filed under a machine id, the comparison picks the
 * baseline matching the current machine, and crossing machines has to be asked
 * for explicitly.
 *
 * The id is deliberately coarse: platform, arch, and a slug of the CPU model.
 * Core count and RAM are recorded in the detail block but kept OUT of the id,
 * because they change with a BIOS setting or a stick of RAM and would silently
 * orphan a machine's own history.
 */
'use strict';

const os = require('os');

function slug(s){
    return String(s || 'unknown')
        .toLowerCase()
        .replace(/\(r\)|\(tm\)|\bcpu\b|\bprocessor\b|@.*$/g, ' ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'unknown';
}

/**
 * Short, filesystem-safe, human-readable. e.g.
 *   'win32-x64-amd-ryzen-7-7700x-8-core'
 *   'darwin-arm64-apple-m2'
 */
function machineId(){
    const cpus = os.cpus();
    const model = cpus && cpus.length ? cpus[0].model : 'unknown';
    return os.platform() + '-' + os.arch() + '-' + slug(model);
}

/** Everything worth recording, including the parts kept out of the id. */
function machineDetail(){
    const cpus = os.cpus() || [];
    return {
        id:       machineId(),
        platform: os.platform(),
        arch:     os.arch(),
        cpu:      cpus.length ? cpus[0].model : 'unknown',
        cores:    cpus.length,
        memoryGB: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
        release:  os.release(),
        node:     process.version
    };
}

module.exports = { machineId, machineDetail, slug };
