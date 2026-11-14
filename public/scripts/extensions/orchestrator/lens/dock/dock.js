// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Run panel (side dock): replaces Luker's two run panels (search agent +
// orchestrator) with one live feed beside the chat. Desktop: a small
// draggable floating window showing only the current round (Enlarge opens a
// centred panel with every round); ≤ 860px: a bottom sheet. Collapses to a
// small pill. Everything is read from the recorder; nothing here writes
// to Luker.

import { h, clear, put, copyText, debounce } from '../../../lens-shared/util.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat, listSeparator, agentName, agentRole, statusLabel, modeInfo } from '../i18n.js';
import { buildRunView, formatDuration, formatTokens } from '../model/run.js';
import { segmentPreview } from '../model/describe.js';
import { buildBlocks, runCounts, liveSummary, currentBlock, blockLabel } from './dock-model.js';
import { iconButton } from '../ui/components.js';
import { fitToViewport } from '../viewport.js';
import { agentAvatar, toneOf } from '../views/flow-view.js';
import { renderSections } from '../views/sections.js';

const PREF_KEY = 'orchestraLens.dock.v1';
const COMPACT_QUERY = '(max-width: 860px)';
const DEFAULT_SIZE = { width: 300, height: 560 }; // floating window: width, max-height
const WIDTH_RANGE = [240, 560];
const MIN_HEIGHT = 160;
const NARROW_WIDTH = 280; // below this the one-line header drops the tokens figure
const DEFAULT_POS = { right: 20, bottom: 84 }; // px from the viewport's right / bottom edge
const SHRINK_AFTER_MS = 4000;

function loadPrefs() {
    try { return JSON.parse(globalThis.localStorage?.getItem(PREF_KEY) || '{}') || {}; } catch { return {}; }
}
function savePrefs(prefs) {
    try { globalThis.localStorage?.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* optional */ }
}

/** Luker's own theme: judge its panel tint colour; fall back to the OS. */
function hostTheme() {
    const tint = getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBlurTintColor').trim();
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(tint);
    if (m) {
        const [r, g, b] = m.slice(1, 4).map(Number);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? 'light' : 'dark';
    }
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** The lens's own theme toggle wins; otherwise follow Luker. */
function detectTheme() {
    const pref = (() => { try { return JSON.parse(localStorage.getItem('orchestraLens.prefs.v1') || '{}').theme; } catch { return ''; } })();
    if (pref === 'light' || pref === 'dark') return pref;
    return hostTheme();
}

/**
 * @param {{ recorder: object, getFlow?: () => object|null, openLens?: (runKey?: string) => void, container?: HTMLElement }} options
 */
export function createDock({ recorder, getFlow = () => null, openLens = null, onDiagnose = null, container = document.body }) {
    const prefs = { autoOpen: true, ...loadPrefs() };
    const compactMql = globalThis.matchMedia?.(COMPACT_QUERY);
    let state = 'closed'; // closed | open | pill
    let expanded = new Set(); // segment keys with their detail open
    let pinnedBottom = true;
    let shownRunKey = '';
    let shownBlockId = '';
    let destroyed = false;
    let size = 'small'; // desktop only: small (floating, current round) | large (centred, every round)
    let menuOpen = false;
    let shrinkTimer = 0;
    const isFloat = () => !compactMql?.matches;

    const root = h('div', { class: 'olens ol-dock', role: 'complementary', 'aria-label': i18n('Run panel'), tabIndex: -1, dataset: { state } });
    const head = h('header', { class: 'ol-dock-head' });
    const body = h('div', { class: 'ol-dock-body' });
    const foot = h('footer', { class: 'ol-dock-foot' });
    const grip = h('div', { class: 'ol-dock-grip', 'aria-hidden': 'true' });
    const resizer = h('div', { class: 'ol-dock-resize', title: i18n('Drag to resize'), 'aria-hidden': 'true' });
    const menu = h('div', { class: 'ol-menu ol-dock-menu', role: 'menu', hidden: true });
    const toastEl = h('div', { class: 'ol-dock-toast', hidden: true });
    put(root, grip, resizer, head, body, foot, menu, toastEl);
    const pillMain = h('button', { type: 'button', class: 'ol-dock-pill-main', onClick: () => setState('open') });
    const pillClose = h('button', { type: 'button', class: 'ol-dock-pill-x', title: i18n('Close'), 'aria-label': i18n('Close'), onClick: () => setState('closed') }, icon('x', { size: 12 }));
    const pill = h('div', { class: 'olens ol-dock-pill', hidden: true }, pillMain, pillClose);
    const scrim = h('div', { class: 'olens ol-dock-scrim', onClick: () => (isFloat() ? setSize('small') : collapse()) });

    // Keys typed in the panel shouldn't drive Luker's swipe / edit hotkeys.
    root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            if (menuOpen) setMenu(false);
            else if (isFloat() && size === 'large') setSize('small');
            else collapse();
            return;
        }
        event.stopPropagation();
    });
    body.addEventListener('scroll', () => {
        pinnedBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    });

    function applyTheme() {
        const theme = detectTheme();
        root.dataset.theme = theme;
        pill.dataset.theme = theme;
        scrim.dataset.theme = theme;
    }

    // ---- Desktop floating window: position (right/bottom offsets) + drag ----
    const viewportSize = () => {
        const vv = globalThis.visualViewport;
        return { vw: Math.round(vv?.width ?? innerWidth), vh: Math.round(vv?.height ?? innerHeight) };
    };
    const clampNum = (n, lo, hi) => Math.round(Math.min(Math.max(lo, Number(n) || 0), Math.max(lo, hi)));
    function clampPos(pos, width = floatSize.width) {
        const { vw, vh } = viewportSize();
        return { right: clampNum(pos?.right, 8, vw - width - 8), bottom: clampNum(pos?.bottom, 8, vh - 140) };
    }
    function clampSize(sz, pos = floatPos) {
        const { vw, vh } = viewportSize();
        return {
            width: clampNum(sz?.width, WIDTH_RANGE[0], Math.min(WIDTH_RANGE[1], vw - pos.right - 8)),
            height: clampNum(sz?.height, MIN_HEIGHT, vh - pos.bottom - 16),
        };
    }
    // want* = what the user chose; float* = that, clamped to the current viewport.
    let wantPos = { ...DEFAULT_POS, ...(prefs.pos || {}) };
    let wantSize = { ...DEFAULT_SIZE, ...(prefs.size || {}) };
    let floatSize = { width: clampNum(wantSize.width, ...WIDTH_RANGE), height: wantSize.height };
    let floatPos = clampPos(wantPos);

    function placeFloat() {
        if (!isFloat() || !root.isConnected) return;
        const { vw, vh } = viewportSize();
        const st = root.style;
        if (size === 'large') {
            const width = Math.min(820, vw - 48);
            const height = Math.min(Math.round(vh * 0.86), 920);
            Object.assign(st, { left: `${Math.round((vw - width) / 2)}px`, top: `${Math.round((vh - height) / 2)}px`, right: 'auto', bottom: 'auto', width: `${width}px`, height: `${height}px`, maxHeight: '' });
            return;
        }
        floatPos = clampPos(wantPos, clampNum(wantSize.width, ...WIDTH_RANGE));
        floatSize = clampSize(wantSize, floatPos);
        Object.assign(st, { left: 'auto', top: 'auto', right: `${floatPos.right}px`, bottom: `${floatPos.bottom}px`, width: `${floatSize.width}px`, height: '', maxHeight: `${floatSize.height}px` });
        root.classList.toggle('is-narrow', floatSize.width < NARROW_WIDTH);
    }

    // Resize from the bottom-right corner: the top-left corner stays put, so
    // the right/bottom offsets shrink as width/max-height grow.
    let sizing = null;
    resizer.addEventListener('pointerdown', (event) => {
        if (!isFloat() || size !== 'small' || event.button !== 0) return;
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
        prefs.size = wantSize;
        prefs.pos = wantPos;
        savePrefs(prefs);
    };
    resizer.addEventListener('pointerup', endSize);
    resizer.addEventListener('pointercancel', endSize);

    let drag = null;
    head.addEventListener('pointerdown', (event) => {
        if (!isFloat() || size !== 'small' || event.button !== 0 || event.target.closest('button')) return;
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, pos: { ...floatPos } };
        head.setPointerCapture?.(event.pointerId);
        root.classList.add('is-dragging');
        event.preventDefault();
    });
    head.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        wantPos = clampPos({ right: drag.pos.right - (event.clientX - drag.x), bottom: drag.pos.bottom - (event.clientY - drag.y) });
        placeFloat();
    });
    const endDrag = (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        drag = null;
        root.classList.remove('is-dragging');
        prefs.pos = wantPos;
        savePrefs(prefs);
    };
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);

    function setSize(next) {
        size = next;
        root.dataset.size = size;
        setMenu(false);
        setState(state);
    }

    // ---- ⋯ menu (desktop): the old footer items ----
    function setMenu(open) {
        menuOpen = open;
        menu.hidden = !open;
        if (!open) { clear(menu); return; }
        const item = (label, onClick, extra = {}) => h('button', { type: 'button', class: 'ol-menu-item', role: 'menuitem', onClick, ...extra },
            h('span', { class: 'ol-menu-check' }, extra['aria-checked'] === 'true' ? icon('check', { size: 13 }) : null),
            h('span', { class: 'ol-menu-title', text: label }));
        const data = currentView();
        put(clear(menu),
            item(i18n('Open automatically on run'), () => { prefs.autoOpen = !prefs.autoOpen; savePrefs(prefs); setMenu(true); }, { role: 'menuitemcheckbox', 'aria-checked': String(prefs.autoOpen) }),
            data ? item(i18n('Export trace'), () => { setMenu(false); exportTrace(data.view); }) : null,
            openLens && data ? item(i18n('View in Orchestra Lens'), () => { setMenu(false); openLens(`${data.view.source}:${data.view.runId}`); }) : null);
    }
    const onOutside = (event) => {
        if (menuOpen && !menu.contains(event.target) && !event.target.closest?.('.ol-dock-more')) setMenu(false);
    };
    document.addEventListener('pointerdown', onOutside, true);

    function exportTrace(view) {
        const raw = recorder.currents().find(item => item.runId === view.runId) || recorder.history().find(item => item.runId === view.runId);
        if (!raw) return;
        const text = JSON.stringify(raw, (key, value) => (key === 'abortFn' || key === 'stopFn' ? undefined : value), 2);
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = h('a', { href: url, download: `${view.source === 'search' ? 'search-agent' : 'orch'}-run-${view.runId}.json` });
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    // ---- After a run ends the small window lingers, then shrinks to the pill ----
    function scheduleShrink(delay = SHRINK_AFTER_MS) {
        clearTimeout(shrinkTimer);
        shrinkTimer = setTimeout(() => {
            if (destroyed || !isFloat() || state !== 'open' || size !== 'small' || recorder.isRunning()) return;
            if (menuOpen || drag || sizing || root.matches(':hover')) { scheduleShrink(1500); return; }
            setState('pill');
        }, delay);
    }

    // On phones Luker gives <html> a transform and zero height, so a fixed
    // box resolves against it (bottom:0 ends up at the top of the screen).
    // Measure and write px, like the lens does for its full-screen root.
    const viewportFit = fitToViewport(root, {
        layout(vw, vh) {
            if (compactMql?.matches) {
                const height = Math.round(Math.min(vh * 0.72, 640));
                return { left: 0, top: vh - height, width: vw, height };
            }
            return false; // desktop: placeFloat() owns the box
        },
    });

    const scrimFit = fitToViewport(scrim);
    // The pill keeps its natural width; we only pin its bottom-right corner.
    function placePill() {
        if (pill.hidden || !pill.isConnected) return;
        const vv = globalThis.visualViewport;
        const vw = Math.round(vv?.width ?? innerWidth);
        const vh = Math.round(vv?.height ?? innerHeight);
        const compact = Boolean(compactMql?.matches);
        pill.style.left = '0px'; pill.style.top = '0px'; pill.style.right = 'auto'; pill.style.bottom = 'auto';
        const r = pill.getBoundingClientRect();
        // Desktop: sit where the floating window's bottom-right corner is.
        const marginRight = compact ? 12 : floatPos.right;
        const marginBottom = compact ? 76 : floatPos.bottom;
        pill.style.left = `${vw - marginRight - r.width - r.left + Math.round(vv?.offsetLeft ?? 0)}px`;
        pill.style.top = `${vh - marginBottom - r.height - r.top + Math.round(vv?.offsetTop ?? 0)}px`;
    }
    const onResize = () => { placeFloat(); placePill(); };
    globalThis.addEventListener('resize', onResize);

    function setState(next) {
        if (next !== 'open') setMenu(false);
        if (next !== 'open') clearTimeout(shrinkTimer);
        state = next;
        root.dataset.state = state;
        const compact = Boolean(compactMql?.matches);
        root.classList.toggle('is-compact', compact);
        root.classList.toggle('is-float', !compact);
        root.dataset.size = compact ? 'small' : size;
        if (compact) root.style.maxHeight = '';
        viewportFit.refresh();
        scrimFit.refresh();
        placeFloat();
        scrim.classList.toggle('is-float', !compact);
        scrim.hidden = !(state === 'open' && (compact || size === 'large'));
        render();
        if (!pill.hidden) placePill();
    }

    function collapse() {
        // Desktop keeps a capsule after the run too (click to look again); phones only while running.
        setState(recorder.isRunning() || (isFloat() && currentView()) ? 'pill' : 'closed');
    }

    /** The run to show: the live one if any, else the latest seen this session. */
    function currentView() {
        const runs = recorder.currents().filter(run => !run.quiet);
        const live = runs.find(run => run.status === 'running');
        const raw = live || runs[0];
        if (!raw) return null;
        const flow = raw.source === 'orchestrator' ? getFlow() : null;
        const view = buildRunView(raw, Object.keys(flow?.agents || {}));
        view.source = raw.source;
        view.mode = raw.source === 'search' ? 'search' : view.mode;
        // Show the single-agent mode rather than the spec runtime it runs on.
        if (view.mode === 'spec' && flow?.mode === 'single') view.displayMode = 'single';
        return { view, flow, others: runs.filter(run => run !== raw && run.status === 'running') };
    }

    function modeLabel(view) {
        return modeInfo(view.displayMode || view.mode).label;
    }

    function renderHead(view, counts) {
        const running = view.status === 'running';
        if (isFloat()) { renderFloatHead(view, counts); return; }
        put(clear(head),
            h('div', { class: 'ol-dock-title' },
                h('span', { class: 'ol-dock-mark', dataset: { source: view.source } }, icon(view.source === 'search' ? 'search' : 'conductor', { size: 15 })),
                h('span', { class: 'ol-dock-name', text: view.source === 'search' ? i18n('Online search') : `${i18n('Orchestration')} · ${modeLabel(view)}` }),
                h('span', { class: 'ol-status', dataset: { status: running ? 'running' : view.status } },
                    h('span', { class: 'ol-status-dot', 'aria-hidden': 'true' }),
                    h('span', { text: statusLabel(view.status) })),
                h('span', { class: 'ol-spacer' }),
                running ? iconButton('stop', i18n('Stop run'), () => { recorder.stop(view); }, { className: 'ol-iconbtn-sm ol-dock-stop' }) : null,
                openLens ? iconButton('fit', i18n('View in Orchestra Lens'), () => openLens(`${view.source}:${view.runId}`), { className: 'ol-iconbtn-sm' }) : null,
                iconButton(compactMql?.matches ? 'chevronDown' : 'chevronRight', i18n('Collapse'), () => collapse(), { className: 'ol-iconbtn-sm' })),
            h('div', { class: 'ol-dock-stats' },
                h('span', { class: 'ol-dock-stat' }, icon('clock', { size: 12 }), h('span', { text: formatDuration(view.duration) })),
                counts.agents ? h('span', { class: 'ol-dock-stat' }, icon('user', { size: 12 }), h('span', { text: counts.running > 1 ? i18nFormat('${0} agents · ${1} working at once', counts.agents, counts.running) : i18nFormat('${0} agents', counts.agents) })) : null,
                counts.tools ? h('span', { class: 'ol-dock-stat' }, icon('tool', { size: 12 }), h('span', { text: i18nFormat('${0} calls', counts.tools) })) : null,
                view.tokens ? h('span', { class: 'ol-dock-stat' }, icon('bolt', { size: 12 }), h('span', { text: `${formatTokens(view.tokens)} tokens` })) : null));
    }

    /** Desktop header. Small window: everything on one line; large: title row + stats row. */
    function renderFloatHead(view, counts) {
        const running = view.status === 'running';
        const large = size === 'large';
        if (!large) {
            put(clear(head),
                h('div', { class: 'ol-dock-title ol-dock-oneline' },
                    h('span', { class: 'ol-dock-mark', dataset: { source: view.source } }, icon(view.source === 'search' ? 'search' : 'conductor', { size: 14 })),
                    h('span', { class: 'ol-dock-name', text: view.source === 'search' ? i18n('Online search') : `${i18n('Orchestration')}·${modeLabel(view)}` }),
                    h('span', { class: 'ol-status', dataset: { status: running ? 'running' : view.status }, title: statusLabel(view.status) },
                        h('span', { class: 'ol-status-dot', 'aria-label': statusLabel(view.status) })),
                    h('span', { class: 'ol-dock-mini-stat', title: i18n('Time used'), text: formatDuration(view.duration) }),
                    view.tokens ? h('span', { class: 'ol-dock-mini-stat ol-dock-mini-tokens', title: `${formatTokens(view.tokens)} tokens`, text: formatTokens(view.tokens).replace(/\s+/g, '') }) : null,
                    h('span', { class: 'ol-spacer' }),
                    running ? iconButton('stop', i18n('Stop run'), () => { recorder.stop(view); }, { className: 'ol-iconbtn-sm ol-dock-stop' }) : null,
                    iconButton('fit', i18n('Enlarge'), () => setSize('large'), { className: 'ol-iconbtn-sm' }),
                    iconButton('minus', i18n('Collapse'), () => collapse(), { className: 'ol-iconbtn-sm' }),
                    iconButton('more', i18n('More'), () => setMenu(!menuOpen), { className: 'ol-iconbtn-sm ol-dock-more', pressed: menuOpen })));
            return;
        }
        put(clear(head),
            h('div', { class: 'ol-dock-title' },
                h('span', { class: 'ol-dock-mark', dataset: { source: view.source } }, icon(view.source === 'search' ? 'search' : 'conductor', { size: 15 })),
                h('span', { class: 'ol-dock-name', text: view.source === 'search' ? i18n('Online search') : `${i18n('Orchestration')} · ${modeLabel(view)}` }),
                h('span', { class: 'ol-status', dataset: { status: running ? 'running' : view.status } },
                    h('span', { class: 'ol-status-dot', 'aria-hidden': 'true' }),
                    h('span', { text: statusLabel(view.status) })),
                h('span', { class: 'ol-spacer' }),
                running ? iconButton('stop', i18n('Stop run'), () => { recorder.stop(view); }, { className: 'ol-iconbtn-sm ol-dock-stop' }) : null,
                large ? iconButton('shrink', i18n('Shrink'), () => setSize('small'), { className: 'ol-iconbtn-sm' })
                    : iconButton('fit', i18n('Enlarge'), () => setSize('large'), { className: 'ol-iconbtn-sm' }),
                large ? null : iconButton('minus', i18n('Collapse'), () => collapse(), { className: 'ol-iconbtn-sm' }),
                iconButton('more', i18n('More'), () => setMenu(!menuOpen), { className: 'ol-iconbtn-sm ol-dock-more', pressed: menuOpen })),
            h('div', { class: 'ol-dock-stats' },
                h('span', { class: 'ol-dock-stat' }, icon('clock', { size: 12 }), h('span', { text: formatDuration(view.duration) })),
                large && counts.agents ? h('span', { class: 'ol-dock-stat' }, icon('user', { size: 12 }), h('span', { text: counts.running > 1 ? i18nFormat('${0} agents · ${1} working at once', counts.agents, counts.running) : i18nFormat('${0} agents', counts.agents) })) : null,
                large && counts.tools ? h('span', { class: 'ol-dock-stat' }, icon('tool', { size: 12 }), h('span', { text: i18nFormat('${0} calls', counts.tools) })) : null,
                view.tokens ? h('span', { class: 'ol-dock-stat' }, icon('bolt', { size: 12 }), h('span', { text: `${formatTokens(view.tokens)} tokens` })) : null));
    }

    /** Small window: only the current round / stage, replaced when the next one starts. */
    function roundEl(blk, view) {
        const { tag, title } = blockLabel(blk);
        if (blk.id !== shownBlockId) { shownBlockId = blk.id; pinnedBottom = true; } // follow the new round
        return h('section', { class: 'ol-dock-round', dataset: { status: blk.status } },
            h('div', { class: 'ol-dock-round-head' },
                h('span', { class: 'ol-dock-block-dot', 'aria-hidden': 'true' }),
                h('span', { class: 'ol-dock-round-tag', text: tag }),
                title ? h('span', { class: 'ol-dock-block-title', text: title }) : null,
                blk.parallel ? h('span', { class: 'ol-colflag is-parallel' }, icon('layers', { size: 11 }), h('span', { text: i18n('At once') })) : null,
                blk.review ? h('span', { class: 'ol-colflag', text: i18n('Review step') }) : null,
                h('span', { class: 'ol-spacer' }),
                blk.status !== 'pending' ? h('span', { class: 'ol-dock-block-time', text: formatDuration(blk.duration) }) : null),
            h('ul', { class: 'ol-dock-agents' }, blk.segments.map(seg => agentRow(seg, view))));
    }

    /**
     * Collapsed-row summary. Floating window: always exactly one line (the
     * latest while running), so streaming never changes the row height.
     * Large view: one line while running, up to four once the agent is done.
     * Phones keep the old up-to-four lines.
     */
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
        const row = h('li', { class: 'ol-dock-agent', dataset: { tone: toneOf(seg.agentId), status: pending ? 'pending' : seg.status } },
            h('button', {
                type: 'button',
                class: 'ol-dock-agent-head',
                'aria-expanded': pending ? null : String(open),
                disabled: pending,
                title: agentRole(seg.agentId) || null,
                onClick: () => {
                    if (open) expanded.delete(seg.key); else expanded.add(seg.key);
                    render();
                },
            },
            agentAvatar(seg.agentId, { size: 'sm' }),
            h('span', { class: 'ol-dock-agent-name', text: agentName(seg.agentId) }),
            seg.todo ? h('span', { class: 'ol-dock-agent-tag', text: seg.todo }) : null,
            h('span', { class: 'ol-spacer' }),
            pending ? h('span', { class: 'ol-dock-agent-time', text: i18n('Queued') })
                : seg.status === 'running' ? h('span', { class: 'ol-dock-agent-live' }, h('span', { class: 'ol-pulse' }), h('span', { text: formatDuration(seg.duration) }))
                    : h('span', { class: 'ol-dock-agent-time', text: formatDuration(seg.duration) }),
            pending ? null : icon(seg.status === 'failed' ? 'alert' : open ? 'chevronUp' : 'chevronDown', { size: 13, className: 'ol-dock-agent-chev' })),
            !open && !pending ? h('ul', { class: 'ol-dock-lines' }, summaryLines(preview.lines, seg).map(line => h('li', { class: `ol-dock-line${line.muted ? ' is-muted' : ''}${line.quote ? ' is-quote' : ''}` },
                icon(line.icon, { size: 12 }), h('span', { text: line.text })))) : null,
            open ? h('div', { class: 'ol-dock-detail' }, renderSections(seg.sections, { app: dockApp, mode: view.mode, agentId: seg.agentId })) : null);
        return row;
    }

    function blockEl(blk, view) {
        return h('section', { class: 'ol-dock-block', dataset: { status: blk.status, upcoming: blk.upcoming ? 'true' : null } },
            h('div', { class: 'ol-dock-block-head' },
                h('span', { class: 'ol-dock-block-dot', 'aria-hidden': 'true' }),
                blk.index ? h('span', { class: 'ol-col-tag', text: i18nFormat('Step ${0}', blk.index) }) : null,
                h('span', { class: 'ol-dock-block-title', text: blk.title }),
                blk.parallel ? h('span', { class: 'ol-colflag is-parallel' }, icon('layers', { size: 11 }), h('span', { text: i18n('At once') })) : null,
                blk.review ? h('span', { class: 'ol-colflag', text: i18n('Review step') }) : null,
                h('span', { class: 'ol-spacer' }),
                blk.status !== 'pending' ? h('span', { class: 'ol-dock-block-time', text: formatDuration(blk.duration) }) : null),
            blk.upcoming ? null : h('ul', { class: 'ol-dock-agents' }, blk.segments.map(seg => agentRow(seg, view))));
    }

    function finalEl(view) {
        if (!view.finalText) return null;
        const bodyText = view.mode === 'director';
        const isSearch = view.source === 'search';
        return h('section', { class: 'ol-final ol-dock-final' },
            h('div', { class: 'ol-final-head' },
                icon(bodyText ? 'pen' : 'capsule', { size: 14 }),
                h('span', { class: 'ol-final-title', text: i18n('Final result') }),
                h('span', { class: 'ol-final-note', text: isSearch ? '' : bodyText ? i18n('Reply text sent') : i18n('Injected for the main model') }),
                h('span', { class: 'ol-spacer' }),
                iconButton('copy', i18n('Copy'), async () => { if (await copyText(view.finalText)) toast(i18n('Copied')); }, { className: 'ol-iconbtn-sm' })),
            h('div', { class: 'ol-final-text', text: view.finalText }));
    }

    let toastTimer = 0;
    function toast(text) {
        clearTimeout(toastTimer);
        toastEl.textContent = text;
        toastEl.hidden = false;
        toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1600);
    }

    const dockApp = {
        notify: (text) => toast(text),
        showText: (title, sections) => { if (openLens) openLens(); else toast(title); void sections; },
    };

    function render() {
        if (destroyed) return;
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
            put(clear(head), h('div', { class: 'ol-dock-title' }, h('span', { class: 'ol-dock-name', text: i18n('Run panel') }), h('span', { class: 'ol-spacer' }), iconButton('x', i18n('Close'), () => setState('closed'), { className: 'ol-iconbtn-sm' })));
            put(clear(body), h('p', { class: 'ol-dock-empty', text: i18n('After you send a message, orchestration and search progress shows here live.') }));
            clear(foot);
            shownBlockId = '';
            return;
        }
        const { view, flow, others } = data;
        const key = `${view.source}:${view.runId}`;
        if (key !== shownRunKey) {
            shownRunKey = key;
            shownBlockId = '';
            expanded = new Set();
            pinnedBottom = true;
        }
        if (state === 'pill') {
            const summary = liveSummary(view, flow);
            const source = view.source === 'search' ? i18n('Search') : i18n('Orchestration');
            pill.dataset.status = liveRun ? 'running' : view.status;
            pillClose.hidden = liveRun;
            put(clear(pillMain), liveRun ? h('span', { class: 'ol-pulse' }) : h('span', { class: 'ol-dock-pill-dot', 'aria-hidden': 'true' }),
                h('span', { class: 'ol-dock-pill-text', text: liveRun
                    ? `${view.source === 'search' ? i18n('Searching') : `${i18n('Orchestrating')}${summary ? ` · ${summary}` : ''}`} · ${formatDuration(view.duration)}`
                    : `${i18nFormat('${0} ${1}', source, statusLabel(view.status))} · ${formatDuration(view.duration)}` }));
            // Re-pin when it appears or its text (width) changes.
            if (pillWasHidden || pill.dataset.len !== String(pill.textContent.length)) {
                pill.dataset.len = String(pill.textContent.length);
                placePill();
            }
        }
        if (state !== 'open') return;

        renderHead(view, runCounts(view));
        const blocks = buildBlocks(view, flow);
        const prevScroll = body.scrollTop;
        const diag = onDiagnose && view.status !== 'running' && view.source === 'orchestrator' ? h('div', { class: 'ol-dock-diag' },
            h('button', { type: 'button', class: 'ol-btn ol-btn-sm', onClick: () => onDiagnose(key) }, icon('target', { size: 13 }), h('span', { text: view.status === 'committed' ? i18n('Not happy with the result? AI diagnosis') : i18n('AI diagnosis of what went wrong') }))) : null;
        if (isFloat() && size === 'small') {
            const cur = currentBlock(blocks);
            put(clear(body),
                others.length ? h('div', { class: 'ol-dock-also' }, icon('play', { size: 12 }), h('span', { text: i18nFormat('${0} also running', others.map(r => (r.source === 'search' ? i18n('Online search') : i18n('Orchestration'))).join(listSeparator())) })) : null,
                view.error && view.status !== 'committed' ? h('div', { class: 'ol-run-error' }, icon('alert', { size: 13 }), h('span', { text: humanError(view.error) })) : null,
                cur ? roundEl(cur, view) : h('p', { class: 'ol-dock-empty', text: i18n('Getting ready…') }),
                view.status !== 'running' ? finalEl(view) : null,
                diag);
            body.scrollTop = pinnedBottom ? body.scrollHeight : prevScroll;
            clear(foot);
            return;
        }
        put(clear(body),
            others.length ? h('div', { class: 'ol-dock-also' }, icon('play', { size: 12 }), h('span', { text: i18nFormat('${0} also running', others.map(r => (r.source === 'search' ? i18n('Online search') : i18n('Orchestration'))).join(listSeparator())) })) : null,
            view.error && view.status !== 'committed' ? h('div', { class: 'ol-run-error' }, icon('alert', { size: 13 }), h('span', { text: humanError(view.error) })) : null,
            blocks.length ? h('div', { class: 'ol-dock-blocks' }, blocks.map(blk => blockEl(blk, view))) : h('p', { class: 'ol-dock-empty', text: i18n('Getting ready…') }),
            finalEl(view),
            diag);
        body.scrollTop = pinnedBottom ? body.scrollHeight : prevScroll;
        if (isFloat()) { clear(foot); return; } // desktop: footer items live in the ⋯ menu

        put(clear(foot),
            h('button', {
                type: 'button',
                role: 'switch',
                class: 'ol-switch ol-dock-auto',
                'aria-checked': String(prefs.autoOpen),
                onClick: () => { prefs.autoOpen = !prefs.autoOpen; savePrefs(prefs); render(); },
            }, h('span', { class: 'ol-switch-label', text: i18n('Open automatically on run') }), h('span', { class: 'ol-switch-track' }, h('span', { class: 'ol-switch-thumb' }))));
    }

    function humanError(text) {
        const value = String(text);
        if (/chat changed/i.test(value)) return i18n('The chat changed, so the run stopped');
        if (/abort|user_stopped|stopped/i.test(value)) return i18n('Stopped manually');
        return value;
    }

    const renderSoon = debounce(render, 60);
    const unsubscribe = recorder.subscribe((kind) => {
        if (kind === 'start') {
            const run = recorder.current();
            if (run?.quiet) return;
            clearTimeout(shrinkTimer);
            if (prefs.autoOpen && state !== 'open') setState(compactMql?.matches && state === 'pill' ? 'pill' : 'open');
            else if (!prefs.autoOpen && state === 'closed') setState('pill');
            else render();
            return;
        }
        if (kind === 'clear') { render(); return; }
        if (kind === 'finish' && isFloat() && state === 'open' && size === 'small' && !recorder.isRunning()) scheduleShrink();
        renderSoon();
    });
    const ticker = setInterval(() => { if (state !== 'closed' && recorder.isRunning()) render(); }, 1000);
    const onCompact = () => setState(state);
    compactMql?.addEventListener?.('change', onCompact);

    container.appendChild(scrim);
    container.appendChild(root);
    container.appendChild(pill);
    viewportFit.refresh();
    scrimFit.refresh();
    scrim.hidden = true;
    root.classList.toggle('is-compact', Boolean(compactMql?.matches));
    root.classList.toggle('is-float', isFloat());
    root.dataset.size = size;
    placeFloat();
    applyTheme();
    if (currentView()?.view.status === 'running') setState(prefs.autoOpen ? 'open' : 'pill');

    return {
        open: () => setState('open'),
        close: () => setState('closed'),
        toggle: () => setState(state === 'open' ? 'closed' : 'open'),
        isOpen: () => state === 'open',
        refresh: render,
        destroy() {
            destroyed = true;
            unsubscribe();
            clearInterval(ticker);
            clearTimeout(shrinkTimer);
            document.removeEventListener('pointerdown', onOutside, true);
            compactMql?.removeEventListener?.('change', onCompact);
            viewportFit.destroy();
            scrimFit.destroy();
            globalThis.removeEventListener('resize', onResize);
            root.remove();
            pill.remove();
            scrim.remove();
        },
    };
}
