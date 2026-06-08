// public/scripts/extensions/orchestrator/run-panel/panel.js
/**
 * Run Panel mount / lifecycle / pill affordance.
 *
 * Mount is lazy: the first call to openRunPanel() (either via the menu
 * action or auto-open on RUN_STARTED) injects the stylesheet, mounts
 * the panel shell, and wires the single store subscription. Re-entry
 * just toggles data-state.
 *
 * Pill: when the user manually closes the panel during a running run,
 * a floating "running · Ns" pill appears at the top of the chat. Clicking
 * it reopens. It auto-hides on RUN_FINISHED / RUN_CLEARED.
 */

import { PanelRenderer } from './render-incremental.js';
import { subscribe, getCurrentRun } from '../run-state/store.js';
import * as EV from '../run-state/events.js';
import { i18n } from '../i18n.js';

let mounted = false;
let renderer = null;
let pillEl = null;
let unsubscribe = null;
let pillTimer = null;

function buildShellHtml() {
    return `
<div class="panel-backdrop"></div>
<aside class="panel-shell">
    <header class="panel-header">
        <div class="panel-title">
            <span class="mode-badge"></span>
            <span class="status-dot"></span>
            <span class="elapsed">0.0s</span>
        </div>
        <div class="panel-actions">
            <button data-action="stop" title="${i18n('Stop')}" hidden>■</button>
            <button data-action="export" title="${i18n('Export trace')}">⬇</button>
            <button data-action="collapse-all" title="${i18n('Collapse all')}">⇡</button>
            <button data-action="close" title="${i18n('Close')}">✕</button>
        </div>
        <div class="panel-summary"></div>
    </header>
    <main class="panel-body" data-scroll-pin="bottom">
        <ol class="rounds-list"></ol>
        <section class="final-output" hidden>
            <header>${i18n('Final output')}</header>
            <pre></pre>
        </section>
    </main>
</aside>
`;
}

function injectStylesheet() {
    const id = 'luker-orch-run-panel-css';
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = '/scripts/extensions/orchestrator/run-panel/panel.css';
    document.head.appendChild(link);
}

function mountOnce() {
    if (mounted) return;
    injectStylesheet();
    const root = document.createElement('div');
    root.id = 'luker-orch-run-panel';
    root.dataset.state = 'closed';
    root.dataset.layout = matchMedia('(min-width: 1024px)').matches ? 'sidebar' : 'drawer';
    root.innerHTML = buildShellHtml();
    document.body.appendChild(root);

    pillEl = document.createElement('button');
    pillEl.id = 'luker-orch-run-pill';
    pillEl.hidden = true;
    pillEl.textContent = i18n('Click to reopen');
    pillEl.addEventListener('click', openPanel);
    document.body.appendChild(pillEl);

    renderer = new PanelRenderer(root);

    // Responsive layout flip
    matchMedia('(min-width: 1024px)').addEventListener('change', (e) => {
        root.dataset.layout = e.matches ? 'sidebar' : 'drawer';
    });

    // Header actions
    root.querySelector('[data-action="close"]').addEventListener('click', () => {
        const run = getCurrentRun();
        closePanel();
        if (run && run.status === 'running') showPill();
    });
    root.querySelector('[data-action="stop"]').addEventListener('click', () => renderer.stop());
    root.querySelector('[data-action="export"]').addEventListener('click', () => renderer.exportTrace());
    root.querySelector('[data-action="collapse-all"]').addEventListener('click', () => renderer.collapseAll());
    root.querySelector('.panel-backdrop').addEventListener('click', () => {
        const run = getCurrentRun();
        closePanel();
        if (run && run.status === 'running') showPill();
    });

    mounted = true;
}

function openPanel() {
    mountOnce();
    document.getElementById('luker-orch-run-panel').dataset.state = 'open';
}

function closePanel() {
    const root = document.getElementById('luker-orch-run-panel');
    if (root) root.dataset.state = 'closed';
}

function showPill() {
    if (!pillEl) return;
    pillEl.hidden = false;
    if (pillTimer) clearInterval(pillTimer);
    const tick = () => {
        const r = getCurrentRun();
        if (!r || r.status !== 'running') { hidePill(); return; }
        const sec = ((performance.now() - r.startedAt) / 1000).toFixed(0);
        pillEl.textContent = `● ${i18n('running')} · ${sec}s · ${i18n('Click to reopen')}`;
    };
    tick();
    pillTimer = setInterval(tick, 1000);
}

function hidePill() {
    if (pillEl) pillEl.hidden = true;
    if (pillTimer) { clearInterval(pillTimer); pillTimer = null; }
}

/**
 * Open the run panel from a menu action. If no run is active, paints
 * an empty-state hint. If a run is active, jumps into the live view.
 */
export function openRunPanel(_context) {
    mountOnce();
    const run = getCurrentRun();
    const body = document.querySelector('#luker-orch-run-panel .panel-body');
    // Remove any previously-shown empty-state hint so that a later run's
    // first render isn't shadowed by stale "no active run" copy.
    if (body) {
        const stale = body.querySelector(':scope > .empty-state');
        if (stale) stale.remove();
    }
    if (!run && body) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = i18n('No active run yet. Start a conversation to see orchestration progress here.');
        body.appendChild(empty);
    }
    openPanel();
}

/**
 * Called once at extension boot. Wires the single store subscription
 * (so auto-open on RUN_STARTED works even before the user touches the
 * menu) but defers DOM mounting until the first openPanel call. Calling
 * this multiple times is a no-op.
 */
export function initRunPanel() {
    if (unsubscribe) return;
    unsubscribe = subscribe((event) => {
        // Mount the DOM lazily on first relevant event so users who never
        // run the orchestrator don't pay the cost.
        if (event.type === EV.RUN_STARTED) {
            mountOnce();
            renderer.handle(event);
            openPanel();
            hidePill();
            return;
        }
        if (!mounted) {
            // No DOM yet, no UI to update. RUN_CLEARED / RUN_FINISHED arriving
            // before mount means nothing to hide.
            return;
        }
        renderer.handle(event);
        if (event.type === EV.RUN_FINISHED || event.type === EV.RUN_CLEARED) {
            hidePill();
        }
    });
}
