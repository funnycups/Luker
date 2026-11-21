// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared floating Run Dock: displays live and recent runs from any attached
// RunStore (orchestrator, search-tools, …) in one floating window across
// desktop and mobile viewports, with configurable small/large default size.

import { h, clear, put, copyText, debounce } from '../lens-shared/util.js';
import { accountLocalStorage, currentAccountHandle } from '../lens-shared/current-account.js';
import { button, iconButton } from '../lens-shared/ui.js';
import { icon } from './dock-icons.js';
import { i18n, i18nFormat, listSeparator, agentName, agentRole, statusLabel, modeInfo, toneOf, agentAvatar } from './dock-i18n.js';
import {
    buildRunView,
    formatDuration,
    formatTokens,
    buildBlocks,
    runCounts,
    liveSummary,
    currentBlock,
    blockLabel,
    segmentPreview,
} from './dock-model.js';
import { renderSections } from './dock-sections.js';
import { createRecorder, serializeRunTrace } from './recorder.js';

const PREF_KEY = 'orchestraLens.dock.v1';
const TOKENS_CSS_ID = 'luker-lens-shared-tokens-css';
const DOCK_CSS_ID = 'luker-run-panel-dock-css';
const COMPACT_QUERY = '(max-width: 860px)';
const DEFAULT_SIZE = { width: 300, height: 560 };
const WIDTH_RANGE = [240, 560];
const MIN_HEIGHT = 160;
const NARROW_WIDTH = 280;
const DEFAULT_POS = { right: 20, bottom: 84 };
const DEFAULT_MOBILE_POS = { right: 12, bottom: 96 };
const MOBILE_DEFAULT_WIDTH = 356;
const SHRINK_AFTER_MS = 4000;

export function normalizeDefaultDockSize(value) {
    return value === 'large' ? 'large' : 'small';
}

function normalizePrefsObject(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
        ...src,
        autoOpen: src.autoOpen !== false,
        defaultSize: normalizeDefaultDockSize(src.defaultSize),
    };
}

const prefListeners = new Set();
const liveDocks = new Set();

function notifyPrefListeners(prefs) {
    const snapshot = {
        autoOpen: prefs.autoOpen !== false,
        defaultSize: normalizeDefaultDockSize(prefs.defaultSize),
    };
    for (const fn of prefListeners) {
        try {
            fn(snapshot);
        } catch (err) {
            console.error('[run-panel] pref listener error:', err);
        }
    }
    return snapshot;
}

export function getRunDockPrefs() {
    const storage = accountLocalStorage();
    const handle = currentAccountHandle();
    const loaded = handle ? loadPrefs(storage) : {};
    const normalized = normalizePrefsObject(loaded);
    return {
        autoOpen: normalized.autoOpen,
        defaultSize: normalized.defaultSize,
    };
}

export function setRunDockPrefs(patch = {}) {
    const storage = accountLocalStorage();
    const handle = currentAccountHandle();
    if (!handle || !patch || typeof patch !== 'object') {
        return getRunDockPrefs();
    }
    const next = normalizePrefsObject(loadPrefs(storage));
    if (typeof patch.autoOpen === 'boolean') {
        next.autoOpen = patch.autoOpen;
    }
    if (patch.defaultSize === 'small' || patch.defaultSize === 'large') {
        next.defaultSize = patch.defaultSize;
    }
    if (patch.resetPosition) {
        delete next.pos;
        delete next.size;
        delete next.mobilePos;
        delete next.pillPos;
        delete next.mobilePillPos;
    }
    savePrefs(storage, next);
    for (const dock of liveDocks) {
        dock._applyExternalPrefs?.(patch);
    }
    return notifyPrefListeners(next);
}

export function resetRunDockPosition() {
    return setRunDockPrefs({ resetPosition: true });
}

export function subscribeRunDockPrefs(listener) {
    if (typeof listener !== 'function') return () => {};
    prefListeners.add(listener);
    return () => { prefListeners.delete(listener); };
}

export function ensureDockStyles(doc = globalThis.document) {
    if (!doc?.head) return;
    if (!doc.getElementById(TOKENS_CSS_ID) && !doc.querySelector('link[href*="lens-shared/tokens.css"]')) {
        const link = doc.createElement('link');
        link.id = TOKENS_CSS_ID;
        link.rel = 'stylesheet';
        link.href = new URL('../lens-shared/tokens.css', import.meta.url).href;
        doc.head.appendChild(link);
    }
    if (!doc.getElementById(DOCK_CSS_ID) && !doc.querySelector('link[href*="run-panel/dock.css"]')) {
        const link = doc.createElement('link');
        link.id = DOCK_CSS_ID;
        link.rel = 'stylesheet';
        link.href = new URL('./dock.css', import.meta.url).href;
        doc.head.appendChild(link);
    }
}

function fitToViewport(root, { layout = null } = {}) {
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
        root.style.width = '0px';
        root.style.height = '0px';
        const origin = root.getBoundingClientRect();
        root.style.left = `${left - origin.left}px`;
        root.style.top = `${top - origin.top}px`;
        root.style.width = `${box.width}px`;
        root.style.height = `${box.height}px`;
        root.style.setProperty('--rp-vh', `${vh / 100}px`);
        void root.offsetWidth;
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

function loadPrefs(prefStorage) {
    try {
        const raw = prefStorage?.getItem?.(PREF_KEY);
        return JSON.parse(raw || '{}') || {};
    } catch {
        return {};
    }
}

function savePrefs(prefStorage, prefs) {
    if (!prefStorage?.getHandle?.()) return;
    try {
        prefStorage?.setItem?.(PREF_KEY, JSON.stringify(prefs));
    } catch {
        /* optional UI layout prefs */
    }
}

function hostTheme() {
    const tint = getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBlurTintColor').trim();
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(tint);
    if (m) {
        const [r, g, b] = m.slice(1, 4).map(Number);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? 'light' : 'dark';
    }
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function detectTheme(prefStorage) {
    const pref = (() => {
        try {
            const raw = prefStorage?.getItem?.('orchestraLens.prefs.v1');
            return JSON.parse(raw || '{}')?.theme;
        } catch {
            return '';
        }
    })();
    if (pref === 'light' || pref === 'dark') return pref;
    return hostTheme();
}

/**
 * @param {{
 *   recorder: object,
 *   getFlow?: (source?: string) => object|null,
 *   onInspect?: ((runKey: string) => void)|null,
 *   onDiagnose?: ((runKey: string) => void)|null,
 *   getInspectHandler?: ((source: string) => ((runKey: string) => void)|null)|null,
 *   getDiagnoseHandler?: ((source: string) => ((runKey: string) => void)|null)|null,
 *   container?: HTMLElement,
 * }} options
 */
export function createDock({
    recorder,
    getFlow = () => null,
    onInspect = null,
    onDiagnose = null,
    getInspectHandler = null,
    getDiagnoseHandler = null,
    container = document.body,
}) {
    ensureDockStyles(container?.ownerDocument || document);
    const prefStorage = accountLocalStorage();
    let prefsHandle = currentAccountHandle();
    let prefs = normalizePrefsObject(prefsHandle ? loadPrefs(prefStorage) : {});
    const compactMql = globalThis.matchMedia?.(COMPACT_QUERY);
    let state = 'closed';
    let expanded = new Set();
    let pinnedBottom = true;
    let shownRunKey = '';
    let shownBlockId = '';
    let destroyed = false;
    let size = normalizeDefaultDockSize(prefs.defaultSize);
    let menuOpen = false;
    let shrinkTimer = 0;
    const isCompact = () => Boolean(compactMql?.matches);
    const isFloat = () => true;

    const root = h('div', { class: 'rpdock lw-surface rp-dock is-float', role: 'complementary', 'aria-label': i18n('Run panel'), tabIndex: -1, dataset: { state } });
    const head = h('header', { class: 'rp-dock-head' });
    const body = h('div', { class: 'rp-dock-body' });
    const foot = h('footer', { class: 'rp-dock-foot' });
    const grip = h('div', { class: 'rp-dock-grip', 'aria-hidden': 'true' });
    const resizer = h('div', { class: 'rp-dock-resize', title: i18n('Drag to resize'), 'aria-hidden': 'true' });
    const menu = h('div', { class: 'rp-menu rp-dock-menu', role: 'menu', hidden: true });
    const toastEl = h('div', { class: 'rp-dock-toast', hidden: true });
    put(root, grip, resizer, head, body, foot, menu, toastEl);
    let pillDragged = false;
    const pillMain = h('button', {
        type: 'button',
        class: 'rp-dock-pill-main',
        onClick: () => {
            if (pillDragged) { pillDragged = false; return; }
            syncPrefs();
            size = normalizeDefaultDockSize(prefs.defaultSize);
            setState('open');
        },
    });
    const pillClose = h('button', {
        type: 'button',
        class: 'rp-dock-pill-x',
        title: i18n('Close'),
        'aria-label': i18n('Close'),
        onClick: () => {
            if (pillDragged) { pillDragged = false; return; }
            setState('closed');
        },
    }, icon('x', { size: 13 }));
    const pill = h('div', { class: 'rpdock lw-surface rp-dock-pill', hidden: true }, pillMain, pillClose);
    const scrim = h('div', {
        class: 'rpdock lw-surface rp-dock-scrim is-float',
        onClick: () => (normalizeDefaultDockSize(prefs.defaultSize) === 'large' ? collapse() : setSize('small')),
    });

    root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            if (menuOpen) setMenu(false);
            else if (size === 'large' && normalizeDefaultDockSize(prefs.defaultSize) !== 'large') setSize('small');
            else collapse();
            return;
        }
        event.stopPropagation();
    });
    body.addEventListener('scroll', () => {
        pinnedBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    });

    function applyTheme() {
        const theme = detectTheme(prefStorage);
        root.dataset.theme = theme;
        pill.dataset.theme = theme;
        scrim.dataset.theme = theme;
    }

    const viewportSize = () => {
        const vv = globalThis.visualViewport;
        return {
            vw: Math.round(vv?.width ?? innerWidth),
            vh: Math.round(vv?.height ?? innerHeight),
            ox: Math.round(vv?.offsetLeft ?? 0),
            oy: Math.round(vv?.offsetTop ?? 0),
        };
    };
    const clampNum = (n, lo, hi) => Math.round(Math.min(Math.max(lo, Number(n) || 0), Math.max(lo, hi)));
    function clampPos(pos, width = floatSize.width) {
        const { vw, vh } = viewportSize();
        return { right: clampNum(pos?.right, 8, vw - width - 8), bottom: clampNum(pos?.bottom, 8, vh - 140) };
    }
    function clampMobilePos(pos, width) {
        const { vw, vh } = viewportSize();
        const w = width ?? clampNum(MOBILE_DEFAULT_WIDTH, 220, Math.max(220, vw - 24));
        return { right: clampNum(pos?.right, 8, Math.max(8, vw - w - 8)), bottom: clampNum(pos?.bottom, 8, Math.max(8, vh - 120)) };
    }
    function clampSize(sz, pos = floatPos) {
        const { vw, vh } = viewportSize();
        return {
            width: clampNum(sz?.width, WIDTH_RANGE[0], Math.min(WIDTH_RANGE[1], vw - pos.right - 8)),
            height: clampNum(sz?.height, MIN_HEIGHT, vh - pos.bottom - 16),
        };
    }

    let wantPos = { ...DEFAULT_POS, ...(prefs.pos || {}) };
    let wantSize = { ...DEFAULT_SIZE, ...(prefs.size || {}) };
    let wantMobilePos = { ...DEFAULT_MOBILE_POS, ...(prefs.mobilePos || {}) };
    let wantPillPos = prefs.pillPos && typeof prefs.pillPos === 'object' ? { ...prefs.pillPos } : null;
    let wantMobilePillPos = prefs.mobilePillPos && typeof prefs.mobilePillPos === 'object' ? { ...prefs.mobilePillPos } : null;
    let floatSize = { width: clampNum(wantSize.width, ...WIDTH_RANGE), height: wantSize.height };
    let floatPos = clampPos(wantPos);
    let mobileFloatPos = clampMobilePos(wantMobilePos);

    function reloadPrefsFromStorage({ updateSizeIfClosed = true } = {}) {
        prefs = normalizePrefsObject(prefsHandle ? loadPrefs(prefStorage) : {});
        wantPos = { ...DEFAULT_POS, ...(prefs.pos || {}) };
        wantSize = { ...DEFAULT_SIZE, ...(prefs.size || {}) };
        wantMobilePos = { ...DEFAULT_MOBILE_POS, ...(prefs.mobilePos || {}) };
        wantPillPos = prefs.pillPos && typeof prefs.pillPos === 'object' ? { ...prefs.pillPos } : null;
        wantMobilePillPos = prefs.mobilePillPos && typeof prefs.mobilePillPos === 'object' ? { ...prefs.mobilePillPos } : null;
        floatSize = { width: clampNum(wantSize.width, ...WIDTH_RANGE), height: wantSize.height };
        floatPos = clampPos(wantPos);
        mobileFloatPos = clampMobilePos(wantMobilePos);
        if (updateSizeIfClosed && state !== 'open') {
            size = normalizeDefaultDockSize(prefs.defaultSize);
        }
    }

    function syncPrefs() {
        const nextHandle = currentAccountHandle();
        if (nextHandle === prefsHandle) return;
        prefsHandle = nextHandle;
        reloadPrefsFromStorage({ updateSizeIfClosed: true });
    }

    function placeFloat() {
        if (!root.isConnected) return;
        const { vw, vh, ox, oy } = viewportSize();
        const compact = isCompact();
        const st = root.style;
        if (size === 'large') {
            const marginX = compact ? 24 : 48;
            const maxW = compact ? 560 : 820; // cap-ok: viewport hardware dimensions for centered modal readability
            const maxH = compact ? 680 : 920; // cap-ok: viewport hardware height limit for centered modal
            const ratioH = compact ? 0.78 : 0.86;
            const width = Math.max(240, Math.min(maxW, vw - marginX)); // cap-ok: viewport hardware dimensions for centered modal readability
            const height = Math.max(200, Math.min(Math.round(vh * ratioH), maxH)); // cap-ok: viewport hardware height limit for centered modal
            Object.assign(st, {
                left: `${ox + Math.round((vw - width) / 2)}px`,
                top: `${oy + Math.round((vh - height) / 2)}px`,
                right: '',
                bottom: '',
                width: `${width}px`,
                height: `${height}px`,
                maxHeight: '',
            });
            root.classList.remove('is-narrow');
            return;
        }
        if (compact) {
            const width = clampNum(MOBILE_DEFAULT_WIDTH, 220, Math.max(220, vw - 24));
            mobileFloatPos = clampMobilePos(wantMobilePos, width);
            const maxH = clampNum(Math.min(Math.round(vh * 0.46), 340), 140, Math.max(140, vh - mobileFloatPos.bottom - 12)); // cap-ok: viewport hardware height limit for mobile floating card
            const vvRight = Math.max(0, Math.round((globalThis.innerWidth || vw) - (ox + vw)));
            const vvBottom = Math.max(0, Math.round((globalThis.innerHeight || vh) - (oy + vh)));
            Object.assign(st, {
                left: '',
                top: '',
                right: `${mobileFloatPos.right + vvRight}px`,
                bottom: `${mobileFloatPos.bottom + vvBottom}px`,
                width: `${width}px`,
                height: '',
                maxHeight: `${maxH}px`,
            });
            root.classList.toggle('is-narrow', width < NARROW_WIDTH);
            return;
        }
        floatPos = clampPos(wantPos, clampNum(wantSize.width, ...WIDTH_RANGE));
        floatSize = clampSize(wantSize, floatPos);
        Object.assign(st, { left: '', top: '', right: `${floatPos.right}px`, bottom: `${floatPos.bottom}px`, width: `${floatSize.width}px`, height: '', maxHeight: `${floatSize.height}px` });
        root.classList.toggle('is-narrow', floatSize.width < NARROW_WIDTH);
    }

    let sizing = null;
    resizer.addEventListener('pointerdown', (event) => {
        if (isCompact() || size !== 'small' || event.button !== 0) return;
        const rect = root.getBoundingClientRect();
        sizing = { id: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, pos: { ...floatPos } };
        resizer.setPointerCapture?.(event.pointerId);
        root.classList.add('is-resizing');
        event.preventDefault();
        event.stopPropagation();
    });
    resizer.addEventListener('pointermove', (event) => {
        if (!sizing || event.pointerId !== sizing.id) return;
        const dx = Math.max(event.clientX - sizing.x, 8 - sizing.pos.right);
        const dy = Math.max(event.clientY - sizing.y, 8 - sizing.pos.bottom);
        const width = clampNum(sizing.width + dx, ...WIDTH_RANGE);
        const height = Math.max(MIN_HEIGHT, Math.round(sizing.height + dy));
        wantPos = { right: sizing.pos.right - (width - sizing.width), bottom: sizing.pos.bottom - (height - sizing.height) };
        wantSize = clampSize({ width, height }, wantPos);
        placeFloat();
    });
    const endSize = (event) => {
        if (!sizing || event.pointerId !== sizing.id) return;
        sizing = null;
        root.classList.remove('is-resizing');
        const nextSize = wantSize;
        const nextPos = wantPos;
        syncPrefs();
        wantSize = nextSize;
        wantPos = nextPos;
        prefs.size = wantSize;
        prefs.pos = wantPos;
        savePrefs(prefStorage, prefs);
    };
    resizer.addEventListener('pointerup', endSize);
    resizer.addEventListener('pointercancel', endSize);

    let drag = null;
    let lastHeadTapAt = 0;
    let lastHeadTapPos = { x: 0, y: 0 };
    let lastHeadTouchDblAt = 0;
    head.addEventListener('pointerdown', (event) => {
        if ((event.pointerType === 'mouse' && event.button !== 0) || event.target.closest('button')) return;
        const compact = isCompact();
        drag = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            compact,
            active: false,
            pos: compact ? { ...mobileFloatPos } : { ...floatPos },
        };
    });
    head.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.id || size !== 'small') return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.active) {
            if (Math.hypot(dx, dy) < 6) return;
            drag.active = true;
            head.setPointerCapture?.(event.pointerId);
            root.classList.add('is-dragging');
        }
        event.preventDefault();
        const nextRaw = { right: drag.pos.right - dx, bottom: drag.pos.bottom - dy };
        if (drag.compact) {
            wantMobilePos = clampMobilePos(nextRaw);
        } else {
            wantPos = clampPos(nextRaw);
        }
        placeFloat();
    });
    const finishHeadGesture = (event, cancelled = false) => {
        if (!drag || event.pointerId !== drag.id) return;
        const wasCompact = drag.compact;
        const wasActive = drag.active;
        drag = null;
        root.classList.remove('is-dragging');
        if (wasActive) {
            if (wasCompact) {
                const nextMobilePos = wantMobilePos;
                syncPrefs();
                wantMobilePos = nextMobilePos;
                prefs.mobilePos = wantMobilePos;
            } else {
                const nextPos = wantPos;
                syncPrefs();
                wantPos = nextPos;
                prefs.pos = wantPos;
            }
            savePrefs(prefStorage, prefs);
            return;
        }
        if (!cancelled && event.pointerType !== 'mouse') {
            const now = Date.now();
            if (now - lastHeadTapAt < 320 && Math.hypot(event.clientX - lastHeadTapPos.x, eCoord(event.clientY) - lastHeadTapPos.y) < 28) {
                lastHeadTapAt = 0;
                lastHeadTouchDblAt = now;
                setSize(size === 'large' ? 'small' : 'large');
            } else {
                lastHeadTapAt = now;
                lastHeadTapPos = { x: event.clientX, y: eCoord(event.clientY) };
            }
        }
    };
    const eCoord = (v) => Number(v) || 0;
    head.addEventListener('pointerup', (e) => finishHeadGesture(e, false));
    head.addEventListener('pointercancel', (e) => finishHeadGesture(e, true));
    head.addEventListener('dblclick', (event) => {
        if (event.target.closest('button')) return;
        if (Date.now() - lastHeadTouchDblAt < 450) return;
        setSize(size === 'large' ? 'small' : 'large');
    });

    function setSize(next) {
        size = normalizeDefaultDockSize(next);
        root.dataset.size = size;
        setMenu(false);
        setState(state);
    }

    function resolveInspect(source) {
        return getInspectHandler?.(source) || onInspect || null;
    }

    function resolveDiagnose(source) {
        return getDiagnoseHandler?.(source) || onDiagnose || null;
    }

    function updateDefaultSizeFromMenu(nextDefault) {
        syncPrefs();
        prefs.defaultSize = normalizeDefaultDockSize(nextDefault);
        savePrefs(prefStorage, prefs);
        notifyPrefListeners(prefs);
        size = prefs.defaultSize;
        setMenu(false);
        setState(state);
    }

    function setMenu(open) {
        syncPrefs();
        menuOpen = open;
        menu.hidden = !open;
        if (!open) { clear(menu); return; }
        const item = (label, onClick, extra = {}) => h('button', { type: 'button', class: 'rp-menu-item', role: 'menuitem', onClick, ...extra },
            h('span', { class: 'rp-menu-check' }, extra['aria-checked'] === 'true' ? icon('check', { size: 13 }) : null),
            h('span', { class: 'rp-menu-title', text: label }));
        const sep = () => h('div', { class: 'rp-menu-sep', role: 'separator' });
        const data = currentView();
        const inspectFn = data ? resolveInspect(data.view.source) : null;
        const defSize = normalizeDefaultDockSize(prefs.defaultSize);
        put(clear(menu),
            item(i18n('Open automatically on run'), () => {
                syncPrefs();
                prefs.autoOpen = !prefs.autoOpen;
                savePrefs(prefStorage, prefs);
                notifyPrefListeners(prefs);
                setMenu(true);
            }, { role: 'menuitemcheckbox', 'aria-checked': String(prefs.autoOpen) }),
            sep(),
            item(i18n('Open in small window by default'), () => updateDefaultSizeFromMenu('small'), { role: 'menuitemradio', 'aria-checked': String(defSize === 'small') }),
            item(i18n('Open in large window by default'), () => updateDefaultSizeFromMenu('large'), { role: 'menuitemradio', 'aria-checked': String(defSize === 'large') }),
            data ? sep() : null,
            data ? item(i18n('Export trace'), () => { setMenu(false); exportTrace(data.view); }) : null,
            inspectFn && data ? item(i18n('Inspect run'), () => { setMenu(false); inspectFn(data.view.runKey); }) : null);
        const { vh } = viewportSize();
        const headRect = head.getBoundingClientRect();
        const spaceBelow = vh - headRect.bottom;
        const flipUp = size === 'small' && spaceBelow < 240 && headRect.top > 220;
        menu.classList.toggle('is-up', flipUp);
    }
    const onOutside = (event) => {
        if (menuOpen && !menu.contains(event.target) && !event.target.closest?.('.rp-dock-more')) setMenu(false);
    };
    document.addEventListener('pointerdown', onOutside, true);

    function rawForView(view) {
        if (!view) return null;
        return recorder.getRun?.(view.runKey)
            || recorder.currents().find(item => `${item.source}:${item.runId}` === view.runKey)
            || recorder.history().find(item => `${item.source}:${item.runId}` === view.runKey)
            || null;
    }

    function serializeCurrentTrace() {
        const data = currentView();
        const raw = rawForView(data?.view);
        return serializeRunTrace(raw);
    }

    function exportTrace(view) {
        const raw = rawForView(view);
        if (!raw) return;
        const text = serializeRunTrace(raw);
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = h('a', { href: url, download: `${view.source === 'search' ? 'search-agent' : view.source || 'run'}-run-${view.runId}.json` });
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    function scheduleShrink(delay = SHRINK_AFTER_MS) {
        clearTimeout(shrinkTimer);
        shrinkTimer = setTimeout(() => {
            if (destroyed || state !== 'open' || size !== 'small' || recorder.isRunning()) return;
            const hovered = (() => { try { return root.matches(':hover'); } catch { return false; } })();
            if (menuOpen || drag || sizing || expanded.size > 0 || hovered) { scheduleShrink(1500); return; }
            setState('pill');
        }, delay);
    }

    const scrimFit = fitToViewport(scrim);
    function clampPillPos(pos, pillW = 180, pillH = 38) {
        const { vw, vh } = viewportSize();
        return {
            right: clampNum(pos?.right, 6, Math.max(6, vw - pillW - 6)),
            bottom: clampNum(pos?.bottom, 6, Math.max(6, vh - pillH - 6)),
        };
    }
    function currentPillMargin(compact, pillW, pillH) {
        const custom = compact ? wantMobilePillPos : wantPillPos;
        const fallback = compact ? { right: 12, bottom: 96 } : floatPos;
        return clampPillPos(custom || fallback, pillW, pillH);
    }
    function placePill() {
        if (pill.hidden || !pill.isConnected) return;
        const vv = globalThis.visualViewport;
        const vw = Math.round(vv?.width ?? innerWidth);
        const vh = Math.round(vv?.height ?? innerHeight);
        const compact = isCompact();
        pill.classList.toggle('is-compact', compact);
        pill.style.left = '0px'; pill.style.top = '0px'; pill.style.right = 'auto'; pill.style.bottom = 'auto';
        const r = pill.getBoundingClientRect();
        const { right: marginRight, bottom: marginBottom } = currentPillMargin(compact, r.width || 180, r.height || 38);
        pill.style.left = `${vw - marginRight - r.width - r.left + Math.round(vv?.offsetLeft ?? 0)}px`;
        pill.style.top = `${vh - marginBottom - r.height - r.top + Math.round(vv?.offsetTop ?? 0)}px`;
    }

    pill.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const compact = isCompact();
        const r = pill.getBoundingClientRect();
        const startMargin = currentPillMargin(compact, r.width || 180, r.height || 38);
        const start = { x: event.clientX, y: event.clientY, ...startMargin, w: r.width || 180, h: r.height || 38 };
        let draggingPill = false;
        pillDragged = false;
        const move = (e) => {
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            if (!draggingPill) {
                if (Math.hypot(dx, dy) < 6) return;
                draggingPill = true;
                pillDragged = true;
                pill.setPointerCapture?.(event.pointerId);
                pill.classList.add('is-dragging');
            }
            e.preventDefault();
            const next = clampPillPos({ right: start.right - dx, bottom: start.bottom - dy }, start.w, start.h);
            if (compact) wantMobilePillPos = next;
            else wantPillPos = next;
            placePill();
        };
        const end = () => {
            pill.classList.remove('is-dragging');
            pill.removeEventListener('pointermove', move);
            pill.removeEventListener('pointerup', end);
            pill.removeEventListener('pointercancel', end);
            if (!draggingPill) return;
            syncPrefs();
            if (compact) prefs.mobilePillPos = wantMobilePillPos;
            else prefs.pillPos = wantPillPos;
            savePrefs(prefStorage, prefs);
        };
        pill.addEventListener('pointermove', move);
        pill.addEventListener('pointerup', end);
        pill.addEventListener('pointercancel', end);
    });
    const onResize = () => { placeFloat(); placePill(); };
    globalThis.addEventListener('resize', onResize);
    globalThis.visualViewport?.addEventListener('resize', onResize);
    globalThis.visualViewport?.addEventListener('scroll', onResize);

    function setState(next) {
        syncPrefs();
        if (next !== 'open') setMenu(false);
        if (next !== 'open') clearTimeout(shrinkTimer);
        state = next;
        root.dataset.state = state;
        const compact = isCompact();
        root.classList.toggle('is-compact', compact);
        pill.classList.toggle('is-compact', compact);
        root.classList.add('is-float');
        root.dataset.size = size;
        scrimFit.refresh();
        placeFloat();
        scrim.classList.add('is-float');
        scrim.hidden = !(state === 'open' && size === 'large');
        render();
        if (!pill.hidden) placePill();
    }

    function collapse() {
        setState(recorder.isRunning() || currentView() ? 'pill' : 'closed');
    }

    function currentView() {
        const runs = recorder.currents().filter(run => !run.quiet);
        const live = runs.find(run => run.status === 'running');
        const raw = live || runs[0];
        if (!raw) return null;
        const flow = raw.source === 'orchestrator' ? getFlow(raw.source) : null;
        const view = buildRunView(raw, Object.keys(flow?.agents || {}));
        view.source = raw.source;
        view.runKey = `${raw.source}:${raw.runId}`;
        view.mode = raw.source === 'search' ? 'search' : view.mode;
        if (view.mode === 'spec' && flow?.mode === 'single') view.displayMode = 'single';
        return { view, flow, others: runs.filter(run => run !== raw && run.status === 'running') };
    }

    function modeLabel(view) {
        return modeInfo(view.displayMode || view.mode).label;
    }

    function sourceIconName(source) {
        if (source === 'search') return 'search';
        if (source === 'sd') return 'image';
        return 'conductor';
    }

    function sourceTitle(view, separator = ' · ') {
        if (view.source === 'search') return i18n('Online search');
        if (view.source === 'sd') return i18n('Image Generation');
        return `${i18n('Orchestration')}${separator}${modeLabel(view)}`;
    }

    function sourceShortLabel(source) {
        if (source === 'search') return i18n('Online search');
        if (source === 'sd') return i18n('Image Generation');
        return i18n('Orchestration');
    }

    function renderHead(view, counts) {
        const running = view.status === 'running';
        const inspectFn = resolveInspect(view.source);
        if (isFloat()) { renderFloatHead(view, counts); return; }
        put(clear(head),
            h('div', { class: 'rp-dock-title' },
                h('span', { class: 'rp-dock-mark', dataset: { source: view.source } }, icon(sourceIconName(view.source), { size: 15 })),
                h('span', { class: 'rp-dock-name', text: sourceTitle(view, ' · ') }),
                h('span', { class: 'rp-status', dataset: { status: running ? 'running' : view.status } },
                    h('span', { class: 'rp-status-dot', 'aria-hidden': 'true' }),
                    h('span', { text: statusLabel(view.status) })),
                h('span', { class: 'rp-spacer' }),
                running ? iconButton('stop', i18n('Stop run'), () => { recorder.stop(view.runKey); }, { className: 'is-sm rp-dock-stop', renderIcon: icon, size: 15 }) : null,
                inspectFn ? iconButton('fit', i18n('Inspect run'), () => inspectFn(view.runKey), { className: 'is-sm', renderIcon: icon, size: 15 }) : null,
                iconButton(compactMql?.matches ? 'chevronDown' : 'chevronRight', i18n('Collapse'), () => collapse(), { className: 'is-sm', renderIcon: icon, size: 15 })),
            h('div', { class: 'rp-dock-stats' },
                h('span', { class: 'rp-dock-stat' }, icon('clock', { size: 12 }), h('span', { text: formatDuration(view.duration) })),
                counts.agents ? h('span', { class: 'rp-dock-stat' }, icon('user', { size: 12 }), h('span', { text: counts.running > 1 ? i18nFormat('${0} agents · ${1} working at once', counts.agents, counts.running) : i18nFormat('${0} agents', counts.agents) })) : null,
                counts.tools ? h('span', { class: 'rp-dock-stat' }, icon('tool', { size: 12 }), h('span', { text: i18nFormat('${0} calls', counts.tools) })) : null,
                view.tokens ? h('span', { class: 'rp-dock-stat' }, icon('bolt', { size: 12 }), h('span', { text: `${formatTokens(view.tokens)} tokens` })) : null));
    }

    function renderFloatHead(view, counts) {
        const running = view.status === 'running';
        const large = size === 'large';
        if (!large) {
            put(clear(head),
                h('div', { class: 'rp-dock-title rp-dock-oneline' },
                    h('span', { class: 'rp-dock-mark', dataset: { source: view.source } }, icon(sourceIconName(view.source), { size: 14 })),
                    h('span', { class: 'rp-dock-name', text: sourceTitle(view, '·') }),
                    h('span', { class: 'rp-status', dataset: { status: running ? 'running' : view.status }, title: statusLabel(view.status) },
                        h('span', { class: 'rp-status-dot', 'aria-label': statusLabel(view.status) })),
                    h('span', { class: 'rp-dock-mini-stat', title: i18n('Time used'), text: formatDuration(view.duration) }),
                    view.tokens ? h('span', { class: 'rp-dock-mini-stat rp-dock-mini-tokens', title: `${formatTokens(view.tokens)} tokens`, text: formatTokens(view.tokens).replace(/\s+/g, '') }) : null,
                    h('span', { class: 'rp-spacer' }),
                    running ? iconButton('stop', i18n('Stop run'), () => { recorder.stop(view.runKey); }, { className: 'is-sm rp-dock-stop', renderIcon: icon, size: 14 }) : null,
                    iconButton('fit', i18n('Enlarge'), () => setSize('large'), { className: 'is-sm', renderIcon: icon, size: 14 }),
                    iconButton('minus', i18n('Collapse'), () => collapse(), { className: 'is-sm', renderIcon: icon, size: 14 }),
                    iconButton('more', i18n('More'), () => setMenu(!menuOpen), { className: 'is-sm rp-dock-more', pressed: menuOpen, renderIcon: icon, size: 14 })));
            return;
        }
        put(clear(head),
            h('div', { class: 'rp-dock-title' },
                h('span', { class: 'rp-dock-mark', dataset: { source: view.source } }, icon(sourceIconName(view.source), { size: 15 })),
                h('span', { class: 'rp-dock-name', text: sourceTitle(view, ' · ') }),
                h('span', { class: 'rp-status', dataset: { status: running ? 'running' : view.status } },
                    h('span', { class: 'rp-status-dot', 'aria-hidden': 'true' }),
                    h('span', { text: statusLabel(view.status) })),
                h('span', { class: 'rp-spacer' }),
                running ? iconButton('stop', i18n('Stop run'), () => { recorder.stop(view.runKey); }, { className: 'is-sm rp-dock-stop', renderIcon: icon, size: 15 }) : null,
                iconButton('shrink', i18n('Shrink'), () => setSize('small'), { className: 'is-sm', renderIcon: icon, size: 15 }),
                iconButton('minus', i18n('Collapse'), () => collapse(), { className: 'is-sm', renderIcon: icon, size: 15 }),
                iconButton('more', i18n('More'), () => setMenu(!menuOpen), { className: 'is-sm rp-dock-more', pressed: menuOpen, renderIcon: icon, size: 15 })),
            h('div', { class: 'rp-dock-stats' },
                h('span', { class: 'rp-dock-stat' }, icon('clock', { size: 12 }), h('span', { text: formatDuration(view.duration) })),
                counts.agents ? h('span', { class: 'rp-dock-stat' }, icon('user', { size: 12 }), h('span', { text: counts.running > 1 ? i18nFormat('${0} agents · ${1} working at once', counts.agents, counts.running) : i18nFormat('${0} agents', counts.agents) })) : null,
                counts.tools ? h('span', { class: 'rp-dock-stat' }, icon('tool', { size: 12 }), h('span', { text: i18nFormat('${0} calls', counts.tools) })) : null,
                view.tokens ? h('span', { class: 'rp-dock-stat' }, icon('bolt', { size: 12 }), h('span', { text: `${formatTokens(view.tokens)} tokens` })) : null));
    }

    function roundEl(blk, view) {
        const { tag, title } = blockLabel(blk);
        if (blk.id !== shownBlockId) { shownBlockId = blk.id; pinnedBottom = true; }
        return h('section', { class: 'rp-dock-round', dataset: { status: blk.status } },
            h('div', { class: 'rp-dock-round-head' },
                h('span', { class: 'rp-dock-block-dot', 'aria-hidden': 'true' }),
                h('span', { class: 'rp-dock-round-tag', text: tag }),
                title ? h('span', { class: 'rp-dock-block-title', text: title }) : null,
                blk.parallel ? h('span', { class: 'rp-colflag is-parallel' }, icon('layers', { size: 11 }), h('span', { text: i18n('At once') })) : null,
                blk.review ? h('span', { class: 'rp-colflag', text: i18n('Review step') }) : null,
                h('span', { class: 'rp-spacer' }),
                blk.status !== 'pending' ? h('span', { class: 'rp-dock-block-time', text: formatDuration(blk.duration) }) : null),
            h('ul', { class: 'rp-dock-agents' }, blk.segments.map(seg => agentRow(seg, view))));
    }

    function summaryLines(lines, seg) {
        if (!isFloat()) return lines.slice(0, 4);
        const running = seg.status === 'running';
        if (size === 'small' || running) {
            const line = running ? lines[lines.length - 1] : lines[0];
            return line ? [line] : [];
        }
        return lines.slice(0, 4);
    }

    function agentRow(seg, view) {
        const pending = seg.pending;
        const open = expanded.has(seg.key);
        const preview = segmentPreview(seg, view.mode);
        return h('li', { class: 'rp-dock-agent', dataset: { tone: toneOf(seg.agentId), status: pending ? 'pending' : seg.status } },
            h('button', {
                type: 'button',
                class: 'rp-dock-agent-head',
                'aria-expanded': pending ? null : String(open),
                disabled: pending,
                title: agentRole(seg.agentId) || null,
                onClick: () => {
                    if (open) expanded.delete(seg.key); else expanded.add(seg.key);
                    render();
                },
            },
            agentAvatar(seg.agentId, { size: 'sm' }),
            h('span', { class: 'rp-dock-agent-name', text: agentName(seg.agentId) }),
            seg.todo ? h('span', { class: 'rp-dock-agent-tag', text: seg.todo }) : null,
            h('span', { class: 'rp-spacer' }),
            pending ? h('span', { class: 'rp-dock-agent-time', text: i18n('Queued') })
                : seg.status === 'running' ? h('span', { class: 'rp-dock-agent-live' }, h('span', { class: 'rp-pulse' }), h('span', { text: formatDuration(seg.duration) }))
                    : h('span', { class: 'rp-dock-agent-time', text: formatDuration(seg.duration) }),
            pending ? null : icon(seg.status === 'failed' ? 'alert' : open ? 'chevronUp' : 'chevronDown', { size: 13, className: 'rp-dock-agent-chev' })),
            !open && !pending ? h('ul', { class: 'rp-dock-lines' }, summaryLines(preview.lines, seg).map(line => h('li', { class: `rp-dock-line${line.muted ? ' is-muted' : ''}${line.quote ? ' is-quote' : ''}` },
                icon(line.icon, { size: 12 }), h('span', { text: line.text })))) : null,
            open ? h('div', { class: 'rp-dock-detail' }, renderSections(seg.sections, { app: dockApp(view), mode: view.mode, agentId: seg.agentId })) : null);
    }

    function blockEl(blk, view) {
        return h('section', { class: 'rp-dock-block', dataset: { status: blk.status, upcoming: blk.upcoming ? 'true' : null } },
            h('div', { class: 'rp-dock-block-head' },
                h('span', { class: 'rp-dock-block-dot', 'aria-hidden': 'true' }),
                blk.index ? h('span', { class: 'rp-col-tag', text: i18nFormat('Step ${0}', blk.index) }) : null,
                h('span', { class: 'rp-dock-block-title', text: blk.title }),
                blk.parallel ? h('span', { class: 'rp-colflag is-parallel' }, icon('layers', { size: 11 }), h('span', { text: i18n('At once') })) : null,
                blk.review ? h('span', { class: 'rp-colflag', text: i18n('Review step') }) : null,
                h('span', { class: 'rp-spacer' }),
                blk.status !== 'pending' ? h('span', { class: 'rp-dock-block-time', text: formatDuration(blk.duration) }) : null),
            blk.upcoming ? null : h('ul', { class: 'rp-dock-agents' }, blk.segments.map(seg => agentRow(seg, view))));
    }

    function finalEl(view) {
        if (!view.finalText) return null;
        const bodyText = view.mode === 'director';
        const isSearch = view.source === 'search';
        return h('section', { class: 'rp-final rp-dock-final' },
            h('div', { class: 'rp-final-head' },
                icon(bodyText ? 'pen' : 'capsule', { size: 14 }),
                h('span', { class: 'rp-final-title', text: i18n('Final result') }),
                h('span', { class: 'rp-final-note', text: isSearch ? '' : bodyText ? i18n('Reply text sent') : i18n('Injected for the main model') }),
                h('span', { class: 'rp-spacer' }),
                iconButton('copy', i18n('Copy'), async () => { if (await copyText(view.finalText)) toast(i18n('Copied')); }, { className: 'is-sm', renderIcon: icon, size: 14 })),
            h('div', { class: 'rp-final-text', text: view.finalText }));
    }

    let toastTimer = 0;
    function toast(text) {
        clearTimeout(toastTimer);
        toastEl.textContent = text;
        toastEl.hidden = false;
        toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1600);
    }

    const dockApp = (view) => {
        const inspectFn = view ? resolveInspect(view.source) : null;
        return {
            notify: (text) => toast(text),
            showText: inspectFn ? () => inspectFn(view.runKey) : null,
        };
    };

    function storageErrorBanner() {
        const err = recorder.getStorageError?.();
        if (!err) return null;
        return h('div', { class: 'rp-run-error', role: 'alert' }, icon('alert', { size: 13 }), h('span', { text: err.message }));
    }

    function render() {
        if (destroyed) return;
        syncPrefs();
        applyTheme();
        const data = currentView();
        const pillWasHidden = pill.hidden;
        const liveRun = data?.view.status === 'running';
        pill.hidden = !(state === 'pill' && data && (liveRun || isFloat()));
        if (state === 'pill' && !(data && (liveRun || isFloat()))) {
            state = 'closed';
            root.dataset.state = state;
        }
        if (!data) {
            const large = size === 'large';
            const btnSize = large ? 15 : 14;
            put(clear(head), h('div', { class: `rp-dock-title${large ? '' : ' rp-dock-oneline'}` },
                h('span', { class: 'rp-dock-name', text: i18n('Run panel') }),
                h('span', { class: 'rp-spacer' }),
                iconButton(large ? 'shrink' : 'fit', i18n(large ? 'Shrink' : 'Enlarge'), () => setSize(large ? 'small' : 'large'), { className: 'is-sm', renderIcon: icon, size: btnSize }),
                iconButton('more', i18n('More'), () => setMenu(!menuOpen), { className: 'is-sm rp-dock-more', pressed: menuOpen, renderIcon: icon, size: btnSize }),
                iconButton('x', i18n('Close'), () => setState('closed'), { className: 'is-sm', renderIcon: icon, size: btnSize })));
            put(clear(body),
                storageErrorBanner(),
                h('p', { class: 'rp-dock-empty', text: i18n('After you send a message, orchestration and search progress shows here live.') }));
            clear(foot);
            shownBlockId = '';
            return;
        }
        const { view, flow, others } = data;
        const key = view.runKey;
        if (key !== shownRunKey) {
            shownRunKey = key;
            shownBlockId = '';
            expanded = new Set();
            pinnedBottom = true;
        }
        if (state === 'pill') {
            const summary = liveSummary(view, flow);
            const source = view.source === 'search' ? i18n('Search') : view.source === 'sd' ? i18n('Image Generation') : i18n('Orchestration');
            const liveLabel = view.source === 'search'
                ? i18n('Searching')
                : view.source === 'sd'
                    ? i18n('Generating image')
                    : `${i18n('Orchestrating')}${summary ? ` · ${summary}` : ''}`;
            pill.dataset.status = liveRun ? 'running' : view.status;
            pillClose.hidden = liveRun;
            put(clear(pillMain), liveRun ? h('span', { class: 'rp-pulse' }) : h('span', { class: 'rp-dock-pill-dot', 'aria-hidden': 'true' }),
                h('span', { class: 'rp-dock-pill-text', text: liveRun
                    ? `${liveLabel} · ${formatDuration(view.duration)}`
                    : `${i18nFormat('${0} ${1}', source, statusLabel(view.status))} · ${formatDuration(view.duration)}` }));
            if (pillWasHidden || pill.dataset.len !== String(pill.textContent.length)) {
                pill.dataset.len = String(pill.textContent.length);
                placePill();
            }
        }
        if (state !== 'open') return;

        renderHead(view, runCounts(view));
        const blocks = buildBlocks(view, flow);
        const prevScroll = body.scrollTop;
        const diagnoseFn = resolveDiagnose(view.source);
        const diag = diagnoseFn && view.status !== 'running'
            ? h('div', { class: 'rp-dock-diag' },
                button(
                    view.status === 'committed' ? i18n('Not happy with the result? AI diagnosis') : i18n('AI diagnosis of what went wrong'),
                    () => diagnoseFn(key),
                    { icon: icon('target', { size: 13 }), small: true },
                ))
            : null;
        if (isFloat() && size === 'small') {
            const cur = currentBlock(blocks);
            put(clear(body),
                storageErrorBanner(),
                others.length ? h('div', { class: 'rp-dock-also' }, icon('play', { size: 12 }), h('span', { text: i18nFormat('${0} also running', others.map(r => sourceShortLabel(r.source)).join(listSeparator())) })) : null,
                view.error && view.status !== 'committed' ? h('div', { class: 'rp-run-error' }, icon('alert', { size: 13 }), h('span', { text: humanError(view.error) })) : null,
                cur ? roundEl(cur, view) : h('p', { class: 'rp-dock-empty', text: i18n('Getting ready…') }),
                view.status !== 'running' ? finalEl(view) : null,
                diag);
            body.scrollTop = pinnedBottom ? body.scrollHeight : prevScroll;
            clear(foot);
            return;
        }
        put(clear(body),
            storageErrorBanner(),
            others.length ? h('div', { class: 'rp-dock-also' }, icon('play', { size: 12 }), h('span', { text: i18nFormat('${0} also running', others.map(r => (r.source === 'search' ? i18n('Online search') : i18n('Orchestration'))).join(listSeparator())) })) : null,
            view.error && view.status !== 'committed' ? h('div', { class: 'rp-run-error' }, icon('alert', { size: 13 }), h('span', { text: humanError(view.error) })) : null,
            blocks.length ? h('div', { class: 'rp-dock-blocks' }, blocks.map(blk => blockEl(blk, view))) : h('p', { class: 'rp-dock-empty', text: i18n('Getting ready…') }),
            finalEl(view),
            diag);
        body.scrollTop = pinnedBottom ? body.scrollHeight : prevScroll;
        clear(foot);
    }

    function humanError(text) {
        const value = String(text);
        if (/chat changed/i.test(value)) return i18n('The chat changed, so the run stopped');
        if (/abort|user_stopped|stopped/i.test(value)) return i18n('Stopped manually');
        return value;
    }

    const renderSoon = debounce(render, 60);
    const unsubscribe = recorder.subscribe((kind, payload) => {
        if (kind === 'error') {
            if (payload?.message) toast(payload.message);
            render();
            return;
        }
        if (kind === 'start') {
            const run = recorder.current();
            if (run?.quiet) return;
            clearTimeout(shrinkTimer);
            syncPrefs();
            const sourceAutoOpen = sourceConfigs.get(payload)?.autoOpen;
            const shouldAutoOpen = sourceAutoOpen === undefined ? prefs.autoOpen : (prefs.autoOpen && sourceAutoOpen);
            if (shouldAutoOpen && state !== 'open') {
                size = normalizeDefaultDockSize(prefs.defaultSize);
                setState('open');
            } else if (!shouldAutoOpen && state === 'closed' && sourceAutoOpen !== false) {
                setState('pill');
            } else {
                render();
            }
            return;
        }
        if (kind === 'clear') { render(); return; }
        if (kind === 'finish' && state === 'open' && size === 'small' && !recorder.isRunning()) scheduleShrink();
        renderSoon();
    });
    const ticker = setInterval(() => { if (state !== 'closed' && recorder.isRunning()) render(); }, 1000);
    const onCompact = () => setState(state);
    compactMql?.addEventListener?.('change', onCompact);

    container.appendChild(scrim);
    container.appendChild(root);
    container.appendChild(pill);
    scrimFit.refresh();
    scrim.hidden = true;
    root.classList.toggle('is-compact', isCompact());
    root.classList.add('is-float');
    root.dataset.size = size;
    placeFloat();
    applyTheme();
    if (currentView()?.view.status === 'running') {
        size = normalizeDefaultDockSize(prefs.defaultSize);
        setState(prefs.autoOpen ? 'open' : 'pill');
    }

    const api = {
        open: () => {
            syncPrefs();
            if (state !== 'open') {
                size = normalizeDefaultDockSize(prefs.defaultSize);
            }
            setState('open');
        },
        close: () => setState('closed'),
        toggle: () => {
            syncPrefs();
            if (state === 'open') {
                setState('closed');
                return;
            }
            size = normalizeDefaultDockSize(prefs.defaultSize);
            setState('open');
        },
        isOpen: () => state === 'open',
        getSize: () => size,
        setSize: (next) => setSize(next),
        isConnected: () => root.isConnected,
        refresh: render,
        serializeCurrentTrace,
        _applyExternalPrefs(patch = {}) {
            prefsHandle = currentAccountHandle();
            reloadPrefsFromStorage({ updateSizeIfClosed: false });
            if (patch.defaultSize === 'small' || patch.defaultSize === 'large') {
                size = normalizeDefaultDockSize(patch.defaultSize);
                root.dataset.size = size;
            }
            setState(state);
        },
        destroy() {
            destroyed = true;
            liveDocks.delete(api);
            unsubscribe();
            clearInterval(ticker);
            clearTimeout(shrinkTimer);
            clearTimeout(toastTimer);
            renderSoon.cancel?.();
            document.removeEventListener('pointerdown', onOutside, true);
            compactMql?.removeEventListener?.('change', onCompact);
            scrimFit.destroy();
            globalThis.removeEventListener('resize', onResize);
            globalThis.visualViewport?.removeEventListener('resize', onResize);
            globalThis.visualViewport?.removeEventListener('scroll', onResize);
            root.remove();
            pill.remove();
            scrim.remove();
        },
    };
    liveDocks.add(api);
    return api;
}

// ----- Platform singleton runtime --------------------------------------------

const sourceConfigs = new Map();
let singletonRecorder = null;
let singletonDock = null;
let domReadyBound = false;

export function getRunRecorder() {
    if (!singletonRecorder) {
        singletonRecorder = createRecorder({
            storage: accountLocalStorage(),
            getRunContext: (source) => {
                const cfg = sourceConfigs.get(source);
                if (typeof cfg?.getRunContext === 'function') return cfg.getRunContext();
                const ctx = globalThis.Luker?.getContext?.();
                return ctx ? { chatId: ctx.chatId, chatLabel: ctx.name2 } : {};
            },
        });
    }
    return singletonRecorder;
}

function ensureDock() {
    if (typeof document === 'undefined' || !document.body) return null;
    ensureDockStyles(document);
    if (singletonDock && singletonDock.isConnected()) return singletonDock;
    if (singletonDock) {
        singletonDock.destroy();
        singletonDock = null;
    }
    singletonDock = createDock({
        recorder: getRunRecorder(),
        getFlow: (source) => sourceConfigs.get(source)?.getFlow?.() ?? null,
        getInspectHandler: (source) => sourceConfigs.get(source)?.onInspect ?? null,
        getDiagnoseHandler: (source) => sourceConfigs.get(source)?.onDiagnose ?? null,
        container: document.body,
    });
    return singletonDock;
}

export function attachDock(store, opts = {}) {
    if (!store?.subscribe) {
        throw new Error('attachDock requires a RunStore');
    }
    const source = String(opts.source || 'orchestrator');
    sourceConfigs.set(source, {
        autoOpen: typeof opts.autoOpen === 'boolean' ? opts.autoOpen : undefined,
        getRunContext: typeof opts.getRunContext === 'function' ? opts.getRunContext : null,
        getFlow: typeof opts.getFlow === 'function' ? opts.getFlow : null,
        onInspect: typeof opts.onInspect === 'function' ? opts.onInspect : null,
        onDiagnose: typeof opts.onDiagnose === 'function' ? opts.onDiagnose : null,
    });
    const recorder = getRunRecorder();
    recorder.attach(store, source);
    if (typeof document !== 'undefined') {
        ensureDockStyles(document);
        if (document.body) {
            ensureDock();
        } else if (!domReadyBound) {
            domReadyBound = true;
            document.addEventListener('DOMContentLoaded', () => {
                domReadyBound = false;
                ensureDock();
            }, { once: true });
        }
    }
}

export async function openRunDock() {
    const dock = ensureDock();
    dock?.open();
}

export async function toggleRunDock() {
    const dock = ensureDock();
    dock?.toggle();
}
