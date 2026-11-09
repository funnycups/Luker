// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pins the full-screen overlay to the *visible* viewport in pixels.
// On iOS, Luker makes <body> position:fixed (and some themes add transforms
// to ancestors), so `position:fixed; inset:0` can resolve against the wrong
// box and collapse to the content height. We measure visualViewport, subtract
// whatever offset the containing block introduces, and write px sizes inline.
// CSS `inset:0` stays as the fallback until the first measurement.

//
// `layout(vw, vh)` may return a sub-rectangle { left, top, width, height } of
// the viewport (the side dock uses this); default is the whole viewport.
export function fitToViewport(root, { layout = null } = {}) {
    const win = root.ownerDocument?.defaultView || globalThis;
    const vv = win.visualViewport || null;
    let frame = 0;
    let lateTimer = 0;

    function apply() {
        frame = 0;
        if (!root.isConnected) return;
        const vw = Math.round(vv?.width ?? win.innerWidth);
        const vh = Math.round(vv?.height ?? win.innerHeight);
        const box = layout?.(vw, vh) || { left: 0, top: 0, width: vw, height: vh };
        const left = Math.round(vv?.offsetLeft ?? 0) + box.left;
        const top = Math.round(vv?.offsetTop ?? 0) + box.top;
        // Reset to a known origin, then measure where that origin really is
        // (with our own animation / slide transform out of the way).
        const animation = root.style.animation;
        const transform = root.style.transform;
        const transition = root.style.transition;
        root.style.animation = 'none';
        root.style.transition = 'none';
        root.style.transform = 'none';
        root.style.left = '0px';
        root.style.top = '0px';
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        const origin = root.getBoundingClientRect();
        root.style.left = `${left - origin.left}px`;
        root.style.top = `${top - origin.top}px`;
        root.style.width = `${box.width}px`;
        root.style.height = `${box.height}px`;
        root.style.setProperty('--wb-vh', `${vh / 100}px`);
        void root.offsetWidth; // commit the new box before the slide resumes
        root.style.transform = transform;
        root.style.animation = animation;
        root.style.transition = transition;
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
