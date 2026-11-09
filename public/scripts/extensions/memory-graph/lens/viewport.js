// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pins the full-screen overlay to the *visible* viewport in pixels.
// On iOS, Luker makes <body> position:fixed (and some themes add transforms
// to ancestors), so `position:fixed; inset:0` can resolve against the wrong
// box and collapse to the content height. We measure visualViewport, subtract
// whatever offset the containing block introduces, and write px sizes inline.
// CSS `inset:0` stays as the fallback until the first measurement.

export function fitToViewport(root) {
    const win = root.ownerDocument?.defaultView || globalThis;
    const vv = win.visualViewport || null;
    let frame = 0;
    let lateTimer = 0;

    function apply() {
        frame = 0;
        if (!root.isConnected) return;
        const width = Math.round(vv?.width ?? win.innerWidth);
        const height = Math.round(vv?.height ?? win.innerHeight);
        const left = Math.round(vv?.offsetLeft ?? 0);
        const top = Math.round(vv?.offsetTop ?? 0);
        // Reset to a known origin, then measure where that origin really is
        // (with our own entry animation's transform out of the way).
        const animation = root.style.animation;
        root.style.animation = 'none';
        root.style.left = '0px';
        root.style.top = '0px';
        const origin = root.getBoundingClientRect();
        root.style.animation = animation;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        root.style.left = `${left - origin.left}px`;
        root.style.top = `${top - origin.top}px`;
        root.style.width = `${width}px`;
        root.style.height = `${height}px`;
        root.style.setProperty('--ml-vh', `${height / 100}px`);
    }

    function schedule() {
        if (!frame) frame = win.requestAnimationFrame(apply);
    }
    function onOrientation() {
        schedule();
        clearTimeout(lateTimer);
        // iOS reports the old size for a moment after rotating.
        lateTimer = setTimeout(schedule, 350);
    }

    win.addEventListener('resize', schedule);
    win.addEventListener('orientationchange', onOrientation);
    vv?.addEventListener('resize', schedule);
    vv?.addEventListener('scroll', schedule);
    apply();

    return {
        refresh: schedule,
        destroy() {
            win.cancelAnimationFrame(frame);
            clearTimeout(lateTimer);
            win.removeEventListener('resize', schedule);
            win.removeEventListener('orientationchange', onOrientation);
            vv?.removeEventListener('resize', schedule);
            vv?.removeEventListener('scroll', schedule);
        },
    };
}
