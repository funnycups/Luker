// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pins a fixed overlay to the *visible* viewport in pixels.
// Luker applies `-webkit-transform: translateZ(0)` on <html> (making <html> the
// containing block for `position: fixed`) and `position: fixed` on <body> at
// mobile widths (collapsing <html>'s auto height to 0px), and some themes add
// transforms to ancestors. Relying on `position: fixed; inset: 0` alone can
// collapse full-screen backdrops to 0px + padding. We measure visualViewport,
// subtract whatever offset the containing block introduces, and write px sizes
// inline. CSS sizing stays as the fallback until the first measurement.

/**
 * @param {HTMLElement} root
 * @param {{ layout?: ((vw: number, vh: number) => ({ left: number, top: number, width: number, height: number } | false | null)) | null, vhVar?: string | null, resetAnimation?: boolean }} [options]
 * @returns {{ refresh: () => void, destroy: () => void }}
 */
export function fitToViewport(root, { layout = null, vhVar = '--lw-vh', resetAnimation = true } = {}) {
    const win = root.ownerDocument?.defaultView || globalThis;
    const vv = win.visualViewport || null;
    let frame = 0;
    let lateTimer = 0;

    function apply() {
        frame = 0;
        if (!root.isConnected) return;
        const vw = Math.round(vv?.width ?? win.innerWidth);
        const vh = Math.round(vv?.height ?? win.innerHeight);
        const box = layout?.(vw, vh) ?? { left: 0, top: 0, width: vw, height: vh };
        if (box === false) return;
        const left = Math.round(vv?.offsetLeft ?? 0) + box.left;
        const top = Math.round(vv?.offsetTop ?? 0) + box.top;
        // Reset to a known fixed origin with 0x0 size so neither async
        // stylesheet loading (position: static) nor root overflow can poison
        // the containing-block measurement.
        const animation = root.style.animation;
        const transform = root.style.transform;
        const transition = root.style.transition;
        if (resetAnimation) root.style.animation = 'none';
        root.style.transition = 'none';
        root.style.transform = 'none';
        root.style.position = 'fixed';
        root.style.left = '0px';
        root.style.top = '0px';
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        root.style.width = '0px';
        root.style.height = '0px';
        const origin = root.getBoundingClientRect();
        root.style.left = `${left - origin.left}px`;
        root.style.top = `${top - origin.top}px`;
        root.style.width = `${box.width}px`;
        root.style.height = `${box.height}px`;
        if (vhVar) root.style.setProperty(vhVar, `${vh / 100}px`);
        void root.offsetWidth; // commit the new box before transitions/animations resume
        root.style.transform = transform;
        if (resetAnimation) root.style.animation = animation;
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
