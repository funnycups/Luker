// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The floating window: title bar (drag, double-click / double-tap to maximise),
// resize grips, maximise / collapse, and the entry pill. The pill is the
// workbench's resident entry point: it stays in a corner whenever the window is
// folded away, can be dragged, and remembers where it was put. Desktop (`box`)
// and narrow mobile (`mobileBox`, <= 640px) floating geometries are persisted
// independently.

import { i18n, i18nFormat } from '../i18n.js';
import { h, put, clear } from '../../lens-shared/util.js';
import { iconButton } from '../../lens-shared/ui.js';
import { icon } from '../icons.js';
import { fitToViewport } from '../viewport.js';
import { defaultBox, clampBox, compactDefaultBox, clampCompactBox, maxBox, pillPos, clampPill, isCompactWidth, parseSavedBox } from '../model/geometry.js';
import { loadPrefs, savePrefs } from '../prefs.js';

/**
 * @param {{ title: string, onThemeToggle(): void, theme: () => string, defaultSize?: () => string, startCollapsed?: boolean, pillVisible?: () => boolean, onExpand?(): void, onCollapse?(): void }} options
 * @returns {{ layer: HTMLElement, body: HTMLElement, win: HTMLElement, setContext(text: string): void, setPill(...nodes: any[]): void, setMaximised(next: boolean): void, resetPosition(): void, refresh(): void, collapse(): void, expand(): void, toggle(): void, isCollapsed(): boolean, isCompact(): boolean, paintTheme(): void, focus(): void, destroy(): void }}
 */
export function createWindow({ title, onThemeToggle, theme, defaultSize = null, startCollapsed = false, pillVisible = () => true, onExpand = null, onCollapse = null }) {
    const prefs = loadPrefs();
    let box = parseSavedBox(prefs.box);
    let mobileBox = parseSavedBox(prefs.mobileBox);
    const configuredDefault = () => {
        const val = typeof defaultSize === 'function' ? defaultSize() : '';
        return val === 'large' || val === 'small' ? val : '';
    };
    let maximised = typeof prefs.maximised === 'boolean'
        ? prefs.maximised
        : configuredDefault() === 'large';
    let pillAt = prefs.pill && typeof prefs.pill === 'object' ? prefs.pill : null;
    let collapsed = Boolean(startCollapsed);
    let compact = false;
    let vw = globalThis.innerWidth || 1280;
    let vh = globalThis.innerHeight || 800;

    const ctx = h('span', { class: 'wb-title-ctx' });
    const themeBtn = iconButton('sun', i18n('Toggle light/dark'), () => { onThemeToggle(); paintTheme(); }, { renderIcon: icon });
    const maxBtn = iconButton('max', i18n('Maximize'), () => toggleMax(), { className: 'wb-ctl-max', renderIcon: icon });
    const bar = h('header', { class: 'wb-titlebar' },
        h('span', { class: 'wb-mark', 'aria-hidden': 'true' }, icon('mark', { size: 16 })),
        h('span', { class: 'wb-title', text: title }),
        ctx,
        h('span', { class: 'wb-spacer' }),
        themeBtn,
        maxBtn,
        iconButton('x', i18n('Fold to corner'), () => collapse(), { className: 'is-close', renderIcon: icon }));
    const body = h('div', { class: 'wb-body' });
    const bottomGrip = h('div', { class: 'wb-resize-y', 'aria-hidden': 'true' });
    const grip = h('div', { class: 'wb-resize', 'aria-hidden': 'true' });
    const win = h('section', { class: 'wb-win', role: 'dialog', 'aria-label': title, tabIndex: -1 }, bar, body, bottomGrip, grip);
    const pill = h('button', { type: 'button', class: 'wb-pill', hidden: true, 'aria-label': i18nFormat('Open the ${0}', title), title: i18nFormat('Open ${0} (draggable)', title) });
    const layer = h('div', { class: 'wbench lw-surface', dataset: { theme: theme() } }, win, pill);

    function paintTheme() {
        layer.dataset.theme = theme();
        clear(themeBtn);
        put(themeBtn, icon(theme() === 'dark' ? 'sun' : 'moon'));
    }

    function apply() {
        compact = isCompactWidth(vw);
        layer.classList.toggle('is-compact', compact);
        win.classList.toggle('is-max', maximised);
        clear(maxBtn);
        put(maxBtn, icon(maximised ? 'restore' : 'max'));
        maxBtn.title = maxBtn.ariaLabel = maximised ? i18n('Restore size') : i18n('Maximize');
        win.hidden = collapsed;
        pill.hidden = !collapsed || !pillVisible();
        const b = maximised
            ? maxBox(vw, vh)
            : compact
                ? (mobileBox = clampCompactBox(mobileBox || compactDefaultBox(vw, vh), vw, vh))
                : (box = clampBox(box || defaultBox(vw, vh), vw, vh));
        Object.assign(win.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
        placePill();
    }

    function placePill() {
        const size = pill.hidden ? undefined : { width: pill.offsetWidth || 200, height: pill.offsetHeight || 42 };
        const p = clampPill(pillAt || pillPos(vw, vh, compact), vw, vh, size);
        Object.assign(pill.style, { right: `${p.right}px`, bottom: `${p.bottom}px` });
    }

    // ----- Pill: tap opens, drag moves (remembered) -----
    let dragged = false;
    pill.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const start = { x: event.clientX, y: event.clientY, ...clampPill(pillAt || pillPos(vw, vh, compact), vw, vh) };
        dragged = false;
        pill.setPointerCapture?.(event.pointerId);
        const move = (e) => {
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            if (!dragged && Math.hypot(dx, dy) < 6) return;
            dragged = true;
            pill.classList.add('is-dragging');
            pillAt = clampPill({ right: start.right - dx, bottom: start.bottom - dy }, vw, vh, { width: pill.offsetWidth, height: pill.offsetHeight });
            Object.assign(pill.style, { right: `${pillAt.right}px`, bottom: `${pillAt.bottom}px` });
        };
        const end = () => {
            pill.classList.remove('is-dragging');
            pill.removeEventListener('pointermove', move);
            pill.removeEventListener('pointerup', end);
            pill.removeEventListener('pointercancel', end);
            if (dragged) savePrefs({ pill: pillAt });
        };
        pill.addEventListener('pointermove', move);
        pill.addEventListener('pointerup', end);
        pill.addEventListener('pointercancel', end);
    });
    pill.addEventListener('click', () => {
        if (dragged) { dragged = false; return; }
        expand();
    });

    const persist = () => savePrefs({ box, mobileBox, maximised });

    function toggleMax() {
        maximised = !maximised;
        apply();
        persist();
    }

    // ----- Drag (title bar with 6px deadzone & touch double-tap to maximise) -----
    let lastBarTapAt = 0;
    let lastBarTapPos = { x: 0, y: 0 };
    let lastTouchDblTapAt = 0;
    bar.addEventListener('pointerdown', (event) => {
        if ((event.pointerType === 'mouse' && event.button !== 0) || event.target.closest('button')) return;
        const isMobile = compact;
        const cur = isMobile ? (mobileBox || compactDefaultBox(vw, vh)) : (box || defaultBox(vw, vh));
        const start = { x: event.clientX, y: event.clientY, left: cur.left, top: cur.top };
        let draggingBar = false;
        const move = (e) => {
            if (maximised) return;
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            if (!draggingBar) {
                if (Math.hypot(dx, dy) < 6) return;
                draggingBar = true;
                bar.setPointerCapture?.(event.pointerId);
                bar.classList.add('is-dragging');
            }
            e.preventDefault();
            if (isMobile) {
                mobileBox = clampCompactBox({ ...cur, ...(mobileBox || {}), left: start.left + dx, top: start.top + dy }, vw, vh);
                win.style.left = `${mobileBox.left}px`;
                win.style.top = `${mobileBox.top}px`;
            } else {
                box = clampBox({ ...cur, ...(box || {}), left: start.left + dx, top: start.top + dy }, vw, vh);
                win.style.left = `${box.left}px`;
                win.style.top = `${box.top}px`;
            }
        };
        const end = (e) => {
            bar.classList.remove('is-dragging');
            bar.removeEventListener('pointermove', move);
            bar.removeEventListener('pointerup', end);
            bar.removeEventListener('pointercancel', cancel);
            if (draggingBar) {
                persist();
                return;
            }
            if (e.pointerType !== 'mouse') {
                const now = Date.now();
                if (now - lastBarTapAt < 320 && Math.hypot(e.clientX - lastBarTapPos.x, e.clientY - lastBarTapPos.y) < 28) {
                    lastBarTapAt = 0;
                    lastTouchDblTapAt = now;
                    toggleMax();
                } else {
                    lastBarTapAt = now;
                    lastBarTapPos = { x: e.clientX, y: e.clientY };
                }
            }
        };
        const cancel = () => {
            bar.classList.remove('is-dragging');
            bar.removeEventListener('pointermove', move);
            bar.removeEventListener('pointerup', end);
            bar.removeEventListener('pointercancel', cancel);
            if (draggingBar) persist();
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', end);
        bar.addEventListener('pointercancel', cancel);
    });
    bar.addEventListener('dblclick', (event) => {
        if (event.target.closest('button')) return;
        if (Date.now() - lastTouchDblTapAt < 450) return;
        toggleMax();
    });

    // ----- Bottom-edge vertical resize (mobile thumb-friendly height drag) -----
    bottomGrip.addEventListener('pointerdown', (event) => {
        if ((event.pointerType === 'mouse' && event.button !== 0) || maximised) return;
        event.preventDefault();
        const isMobile = compact;
        const cur = isMobile ? (mobileBox || compactDefaultBox(vw, vh)) : (box || defaultBox(vw, vh));
        const start = { y: event.clientY, top: cur.top, height: cur.height };
        bottomGrip.setPointerCapture?.(event.pointerId);
        const move = (e) => {
            const rawH = start.height + (e.clientY - start.y);
            if (isMobile) {
                const maxH = Math.max(0, vh - start.top);
                mobileBox = clampCompactBox({ ...cur, ...(mobileBox || {}), top: start.top, height: Math.min(rawH, maxH) }, vw, vh);
                win.style.top = `${mobileBox.top}px`;
                win.style.height = `${mobileBox.height}px`;
            } else {
                box = clampBox({ ...cur, ...(box || {}), height: rawH }, vw, vh);
                win.style.height = `${box.height}px`;
            }
        };
        const end = () => {
            bottomGrip.removeEventListener('pointermove', move);
            bottomGrip.removeEventListener('pointerup', end);
            bottomGrip.removeEventListener('pointercancel', end);
            persist();
        };
        bottomGrip.addEventListener('pointermove', move);
        bottomGrip.addEventListener('pointerup', end);
        bottomGrip.addEventListener('pointercancel', end);
    });

    // ----- Resize (bottom-right grip) -----
    grip.addEventListener('pointerdown', (event) => {
        if ((event.pointerType === 'mouse' && event.button !== 0) || maximised) return;
        event.preventDefault();
        const isMobile = compact;
        const cur = isMobile ? (mobileBox || compactDefaultBox(vw, vh)) : (box || defaultBox(vw, vh));
        const start = { x: event.clientX, y: event.clientY, left: cur.left, top: cur.top, width: cur.width, height: cur.height };
        grip.setPointerCapture?.(event.pointerId);
        const move = (e) => {
            if (isMobile) {
                const maxW = Math.max(0, vw - start.left);
                const maxH = Math.max(0, vh - start.top);
                mobileBox = clampCompactBox({
                    ...cur,
                    ...(mobileBox || {}),
                    left: start.left,
                    top: start.top,
                    width: Math.min(start.width + e.clientX - start.x, maxW),
                    height: Math.min(start.height + e.clientY - start.y, maxH),
                }, vw, vh);
                win.style.left = `${mobileBox.left}px`;
                win.style.top = `${mobileBox.top}px`;
                win.style.width = `${mobileBox.width}px`;
                win.style.height = `${mobileBox.height}px`;
            } else {
                box = clampBox({ ...box, width: start.width + e.clientX - start.x, height: start.height + e.clientY - start.y }, vw, vh);
                win.style.width = `${box.width}px`;
                win.style.height = `${box.height}px`;
            }
        };
        const end = () => {
            grip.removeEventListener('pointermove', move);
            grip.removeEventListener('pointerup', end);
            grip.removeEventListener('pointercancel', end);
            persist();
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', end);
        grip.addEventListener('pointercancel', end);
    });

    // The layer covers the visible viewport (iOS-safe); the window is
    // positioned inside it in px.
    const fit = fitToViewport(layer, {
        layout: (w, hgt) => {
            vw = w;
            vh = hgt;
            queueMicrotask(apply);
            return null;
        },
    });

    function collapse() {
        const wasCollapsed = collapsed;
        collapsed = true;
        apply();
        if (!wasCollapsed) onCollapse?.();
    }
    function expand() {
        collapsed = false;
        apply();
        win.focus({ preventScroll: true });
        onExpand?.();
    }

    paintTheme();
    apply();

    return {
        layer,
        body,
        win,
        pill,
        setContext(text) {
            ctx.textContent = text || '';
            ctx.hidden = !text;
        },
        /** Pill content when collapsed (nodes). */
        setPill(...nodes) {
            clear(pill);
            put(pill, h('span', { class: 'wb-mark', 'aria-hidden': 'true' }, icon('mark', { size: 15 })), ...nodes);
            globalThis.requestAnimationFrame?.(placePill);
        },
        setMaximised(next) {
            maximised = Boolean(next);
            apply();
            persist();
        },
        resetPosition() {
            box = null;
            mobileBox = null;
            pillAt = null;
            const def = configuredDefault();
            maximised = def === 'large';
            try {
                const p = JSON.parse(globalThis.localStorage?.getItem('workbench.prefs.v1') || '{}');
                delete p.box;
                delete p.mobileBox;
                delete p.pill;
                delete p.maximised;
                globalThis.localStorage?.setItem('workbench.prefs.v1', JSON.stringify(p));
            } catch { /* ignore */ }
            apply();
        },
        refresh() {
            apply();
            fit.refresh();
        },
        collapse,
        expand,
        toggle: () => (collapsed ? expand() : collapse()),
        isCollapsed: () => collapsed,
        isCompact: () => compact,
        paintTheme,
        focus: () => win.focus({ preventScroll: true }),
        destroy() {
            fit.destroy();
            layer.remove();
        },
    };
}
