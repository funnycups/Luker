/**
 * Bind a column resizer to a `.luker-iter-workspace-grid` root.
 * Caller passes the popup root element; we listen for pointerdown on
 * `.luker-iter-workspace-resizer` inside and adjust `--luker-iter-split`
 * inline-style on the grid wrapper.
 *
 * Split state is NOT persisted — every popup open starts at 50%.
 *
 * Returns an unbind function for cleanup on popup close.
 */
export function bindIterWorkspaceResizer(workspaceRoot) {
    const grid = workspaceRoot?.querySelector?.('.luker-iter-workspace-grid');
    const splitter = workspaceRoot?.querySelector?.('.luker-iter-workspace-resizer');
    if (!grid || !splitter) return () => {};

    let pointerId = null;
    let bounds = null;

    const minPercent = 25;
    const maxPercent = 80;

    function applySplitAt(clientX) {
        if (!bounds) return;
        const percent = ((clientX - bounds.left) / bounds.width) * 100;
        const clamped = Math.max(minPercent, Math.min(maxPercent, percent));
        grid.style.setProperty('--luker-iter-split', `${clamped}%`);
    }

    function onPointerMove(e) {
        if (e.pointerId !== pointerId) return;
        e.preventDefault();
        applySplitAt(e.clientX);
    }

    function onPointerUp(e) {
        if (e.pointerId !== pointerId) return;
        e.preventDefault();
        cleanup();
    }

    function cleanup() {
        if (pointerId !== null) {
            try { splitter.releasePointerCapture(pointerId); } catch { /* ignore */ }
        }
        splitter.classList.remove('active');
        pointerId = null;
        bounds = null;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
    }

    function onPointerDown(e) {
        e.preventDefault();
        e.stopPropagation();
        bounds = grid.getBoundingClientRect();
        if (!bounds || bounds.width <= 0) return;
        pointerId = e.pointerId;
        splitter.classList.add('active');
        try { splitter.setPointerCapture(pointerId); } catch { /* ignore */ }
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
    }

    splitter.addEventListener('pointerdown', onPointerDown);

    return () => {
        splitter.removeEventListener('pointerdown', onPointerDown);
        cleanup();
    };
}
