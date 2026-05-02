/**
 * devtools-warn.js — shared DevTools detection for all jsColorEngine demos.
 *
 * Chrome DevTools overrides timers and intercepts console calls, slowing
 * performance-sensitive demos significantly:
 *   - Live video soft-proof: 66 fps → 44 fps
 *   - Bench WASM SIMD:       174 MPx/s → 96 MPx/s
 *
 * Include this script on any demo page where frame rate or throughput matters.
 * No dependencies. Self-contained IIFE.
 */
(function () {
    // Detect DevTools via the console object toString trick.
    // Chrome calls the getter when DevTools formats the object for display.
    var open = false;
    var el = new Image();
    Object.defineProperty(el, 'id', { get: function () { open = true; } });
    /* eslint-disable no-console */
    console.log('%c', el);

    if (open) {
        // Inject a fixed-position warning banner above all other content
        var banner = document.createElement('div');
        banner.id = 'devtools-warn-banner';
        banner.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
            'background:#fbbf24', 'color:#0a0e12', 'font:600 13px/1.4 system-ui,sans-serif',
            'padding:8px 16px', 'text-align:center', 'box-shadow:0 2px 8px rgba(0,0,0,0.3)'
        ].join(';');
        banner.textContent = '⚠  DevTools is open — close it for accurate performance results. ' +
                             'DevTools can cut frame rates and throughput by 2–3×.';

        // Dismiss on click
        banner.style.cursor = 'pointer';
        banner.title = 'Click to dismiss';
        banner.addEventListener('click', function () { banner.remove(); });

        // Insert as first child of body (or immediately if DOMContentLoaded)
        if (document.body) {
            document.body.insertBefore(banner, document.body.firstChild);
        } else {
            document.addEventListener('DOMContentLoaded', function () {
                document.body.insertBefore(banner, document.body.firstChild);
            });
        }
    }

    // Always warn in the console so the message is visible even when the
    // banner isn't noticed (and to catch DevTools that open after load)
    console.warn('jsColorEngine demo: DevTools open — close for accurate performance. ' +
                 'DevTools intercepts timers and slows JIT by 2–3×.');
    /* eslint-enable no-console */
})();
