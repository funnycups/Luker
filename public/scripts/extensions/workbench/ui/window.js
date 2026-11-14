// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The floating window: title bar (drag, double-click to maximise), resize
// grip, maximise / collapse, and the entry pill. The pill is the workbench's
// resident entry point: it stays in a corner whenever the window is folded
// away, can be dragged, and remembers where it was put. On narrow screens
// the window becomes a bottom sheet over a scrim. Boxes are remembered.

import { i18n, i18nFormat } from '../i18n.js';
import { h, put, clear } from '../../lens-shared/util.js';
import { icon } from '../icons.js';
import { iconButton } from './components.js';
import { fitToViewport } from '../viewport.js';
import { defaultBox, clampBox, maxBox, sheetBox, pillPos, clampPill, isCompactWidth, parseSavedBox } from '../model/geometry.js';
import { loadPrefs, savePrefs } from '../prefs.js';

/**
 * @param {{ title: string, onThemeToggle(): void, theme: () => string, startCollapsed?: boolean, pillVisible?: () => boolean, onExpand?(): void }} options
 * @returns {{ layer, body, setContext(text), setPill(nodes), collapse(), expand(), isCollapsed(), focus(), destroy() }}
 */
export function createWindow({ title, onThemeToggle, theme, startCollapsed = false, pillVisible = () => true, onExpand = null }) {
    const prefs = loadPrefs();
    let box = parseSavedBox(prefs.box);
    let maximised = Boolean(prefs.maximised);
    let pillAt = prefs.pill && typeof prefs.pill === 'object' ? prefs.pill : null;
    let collapsed = Boolean(startCollapsed);
    let compact = false;
    let vw = globalThis.innerWidth || 1280;
    let vh = globalThis.innerHeight || 800;

    const ctx = h('span', { class: 'wb-title-ctx' });
    const themeBtn = iconButton('sun', i18n('Toggle light/dark'), () => { onThemeToggle(); paintTheme(); });
    const maxBtn = iconButton('max', i18n('Maximize'), () => toggleMax(), { className: 'wb-ctl-max' });
    const bar = h('header', { class: 'wb-titlebar' },
        h('span', { class: 'wb-mark', 'aria-hidden': 'true' }, icon('mark', { size: 16 })),
        h('span', { class: 'wb-title', text: title }),
        ctx,
        h('span', { class: 'wb-spacer' }),
        themeBtn,
        maxBtn,
        iconButton('x', i18n('Fold to corner'), () => collapse(), { className: 'is-close' }));
    const body = h('div', { class: 'wb-body' });
    const grip = h('div', { class: 'wb-resize', 'aria-hidden': 'true' });
    const win = h('section', { class: 'wb-win', role: 'dialog', 'aria-label': title, tabIndex: -1 }, bar, body, grip);
    const scrim = h('div', { class: 'wb-scrim', hidden: true, onClick: () => collapse() });
    const pill = h('button', { type: 'button', class: 'wb-pill', hidden: true, 'aria-label': i18nFormat('Open the ${0}', title), title: i18nFormat('Open ${0} (draggable)', title) });
    const layer = h('div', { class: 'wbench', dataset: { theme: theme() } }, scrim, win, pill);

    function paintTheme() {
        layer.dataset.theme = theme();
        clear(themeBtn);
        put(themeBtn, icon(theme() === 'dark' ? 'sun' : 'moon'));
    }

    function apply() {
        compact = isCompactWidth(vw);
        layer.classList.toggle('is-compact', compact);
        win.classList.toggle('is-max', maximised && !compact);
        clear(maxBtn);
        put(maxBtn, icon(maximised ? 'restore' : 'max'));
        maxBtn.title = maxBtn.ariaLabel = maximised ? i18n('Restore size') : i18n('Maximize');
        win.hidden = collapsed;
        pill.hidden = !collapsed || !pillVisible();
        scrim.hidden = !compact || collapsed;
        const b = compact ? sheetBox(vw, vh) : maximised ? maxBox(vw, vh) : (box = clampBox(box || defaultBox(vw, vh), vw, vh));
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

    const persist = () => savePrefs({ box, maximised });

    function toggleMax() {
        if (compact) return;
        maximised = !maximised;
        apply();
        persist();
    }

    // ----- Drag (title bar) -----
    bar.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.target.closest('button') || compact || maximised) return;
        event.preventDefault();
        const start = { x: event.clientX, y: event.clientY, left: box.left, top: box.top };
        bar.setPointerCapture?.(event.pointerId);
        bar.classList.add('is-dragging');
        const move = (e) => {
            box = clampBox({ ...box, left: start.left + e.clientX - start.x, top: start.top + e.clientY - start.y }, vw, vh);
            win.style.left = `${box.left}px`;
            win.style.top = `${box.top}px`;
        };
        const end = () => {
            bar.classList.remove('is-dragging');
            bar.removeEventListener('pointermove', move);
            bar.removeEventListener('pointerup', end);
            bar.removeEventListener('pointercancel', end);
            persist();
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', end);
        bar.addEventListener('pointercancel', end);
    });
    bar.addEventListener('dblclick', (event) => { if (!event.target.closest('button')) toggleMax(); });

    // ----- Resize (bottom-right grip) -----
    grip.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || compact || maximised) return;
        event.preventDefault();
        const start = { x: event.clientX, y: event.clientY, width: box.width, height: box.height };
        grip.setPointerCapture?.(event.pointerId);
        const move = (e) => {
            box = clampBox({ ...box, width: start.width + e.clientX - start.x, height: start.height + e.clientY - start.y }, vw, vh);
            win.style.width = `${box.width}px`;
            win.style.height = `${box.height}px`;
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
        collapsed = true;
        apply();
    }
    function expand() {
        collapsed = false;
        apply();
        win.focus();
        onExpand?.();
    }

    paintTheme();
    apply();

    return {
        layer,
        body,
        win,
        setContext(text) {
            ctx.textContent = text || '';
            ctx.hidden = !text;
        },
        /** Pill content when collapsed (nodes). */
        setPill(...nodes) {
            clear(pill);
            put(pill, h('span', { class: 'wb-mark', 'aria-hidden': 'true' }, icon('mark', { size: 15 })), ...nodes);
            requestAnimationFrame(placePill);
        },
        refresh: apply,
        collapse,
        expand,
        toggle: () => (collapsed ? expand() : collapse()),
        isCollapsed: () => collapsed,
        isCompact: () => compact,
        paintTheme,
        focus: () => win.focus(),
        destroy() {
            fit.destroy();
            layer.remove();
        },
    };
}
