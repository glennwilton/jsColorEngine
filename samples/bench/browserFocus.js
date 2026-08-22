/*
 * samples/bench/browserFocus.js
 *
 * One primitive every timed test can await:
 *
 *   await browserFocus();
 *
 * Resolves immediately when this tab is focused. If the tab is hidden
 * or blurred, shows #bench-pause and waits for Resume.
 *
 * `browserFocus.lost` is true if focus dropped since the last time
 * this resolved. Timed tight loops should discard a sample when it
 * is still true after the batch:
 *
 *   await browserFocus();
 *   const t0 = performance.now();
 *   run();
 *   if (browserFocus.lost) { await browserFocus(); continue; }
 */

let paused = false;
let lost = false;
const waiters = [];

function overlay() {
    return document.getElementById('bench-pause');
}

function isForeground() {
    return !document.hidden && document.hasFocus();
}

function show() {
    paused = true;
    const el = overlay();
    if (el) el.hidden = false;
}

function hide() {
    paused = false;
    const el = overlay();
    if (el) el.hidden = true;
}

function wake() {
    const pending = waiters.splice(0);
    for (let i = 0; i < pending.length; i++) pending[i]();
}

function noteLost() {
    lost = true;
    if (waiters.length > 0) show();
}

function resume() {
    if (document.hidden) return;
    lost = false;
    hide();
    wake();
}

async function browserFocus() {
    if (!paused && isForeground()) {
        lost = false;
        return;
    }
    show();
    await new Promise((resolve) => { waiters.push(resolve); });
    lost = false;
}

Object.defineProperty(browserFocus, 'lost', {
    get() { return lost || document.hidden; },
    enumerable: true,
});

function installBrowserFocus() {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) noteLost();
    });
    window.addEventListener('blur', noteLost);
    const btn = document.getElementById('bench-pause-resume');
    if (btn) btn.addEventListener('click', resume);
}

export { browserFocus, installBrowserFocus };
