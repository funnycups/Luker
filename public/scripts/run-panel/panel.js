// public/scripts/run-panel/panel.js
/**
 * createRunPanel — mounts a run-panel shell, subscribes to a run store,
 * and drives a PanelRenderer. Mount is lazy: the first open (menu action
 * or non-quiet RUN_STARTED) injects the stylesheet and builds the DOM.
 */

import { PanelRenderer, DEFAULT_KIND_ICONS } from './render-incremental.js';
import * as EV from './events.js';
import { createActivityPill } from '../activity-pill.js';

const DEFAULT_STYLESHEET_URL = '/scripts/run-panel/panel.css';
const DEFAULT_EMPTY_STATE = 'No active run yet. Start a conversation to see orchestration progress here.';

export function createRunPanel(options = {}) {
    const store = options.store;
    if (!store || typeof store.subscribe !== 'function') {
        throw new Error('createRunPanel requires a store option');
    }
    const t = typeof options.t === 'function' ? options.t : (s) => String(s ?? '');
    const idPrefix = String(options.idPrefix || 'luker-run-panel');
    const stylesheetUrl = String(options.stylesheetUrl || DEFAULT_STYLESHEET_URL);
    const autoOpen = options.autoOpen !== false;
    const pillOnStart = options.pillOnStart === true;
    const pillFormatter = typeof options.pillFormatter === 'function' ? options.pillFormatter : null;
    const onOpen = typeof options.onOpen === 'function' ? options.onOpen : null;
    const emptyStateText = options.emptyStateText || DEFAULT_EMPTY_STATE;
    const rendererOptions = {
        store,
        t,
        kindIcons: options.kindIcons || DEFAULT_KIND_ICONS,
        defaultCollapsedKinds: options.defaultCollapsedKinds || [],
        keepOpenKinds: options.keepOpenKinds || [],
        autoCollapseRounds: options.autoCollapseRounds !== false,
        modeLabels: options.modeLabels || {},
        summaryFormatter: options.summaryFormatter,
        exportFilename: options.exportFilename,
        onStop: options.onStop,
    };

    const rootId = idPrefix;
    const pillId = `${idPrefix}-pill`;
    const cssId = `${idPrefix}-css`;

    let mounted = false;
    let renderer = null;
    let pill = null;
    let unsubscribe = null;
    let pillTimer = null;
    let layoutMql = null;
    let layoutHandler = null;

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
            <button data-action="stop" title="${t('Stop')}" hidden>■</button>
            <button data-action="export" title="${t('Export trace')}">⬇</button>
            <button data-action="collapse-all" title="${t('Collapse all')}">⇡</button>
            <button data-action="close" title="${t('Close')}">✕</button>
        </div>
        <div class="panel-summary"></div>
    </header>
    <main class="panel-body" data-scroll-pin="bottom">
        <ol class="rounds-list"></ol>
        <section class="final-output" hidden>
            <header>${t('Final output')}</header>
            <pre></pre>
        </section>
    </main>
</aside>
`;
    }

    function injectStylesheet() {
        if (document.getElementById(cssId)) return;
        const link = document.createElement('link');
        link.id = cssId;
        link.rel = 'stylesheet';
        link.href = stylesheetUrl;
        document.head.appendChild(link);
    }

    function setState(state) {
        const root = document.getElementById(rootId);
        if (root) root.dataset.state = state;
    }

    function mountOnce() {
        if (mounted) return;
        injectStylesheet();
        const root = document.createElement('div');
        root.id = rootId;
        root.className = 'luker-run-panel';
        root.dataset.state = 'closed';
        root.dataset.layout = matchMedia('(min-width: 1024px)').matches ? 'sidebar' : 'drawer';
        root.innerHTML = buildShellHtml();
        document.body.appendChild(root);

        pill = createActivityPill({
            id: pillId,
            className: 'luker-run-panel-pill',
            onOpen: open,
            onError: error => { console.error('[run-panel] could not reopen', error); toastr.error(String(error?.message || error)); },
        });

        renderer = new PanelRenderer(root, rendererOptions);

        layoutMql = matchMedia('(min-width: 1024px)');
        layoutHandler = (e) => {
            root.dataset.layout = e.matches ? 'sidebar' : 'drawer';
        };
        layoutMql.addEventListener('change', layoutHandler);

        root.querySelector('[data-action="close"]').addEventListener('click', () => {
            setState('closed');
            showPill();
        });
        root.querySelector('[data-action="stop"]').addEventListener('click', () => renderer.stop());
        root.querySelector('[data-action="export"]').addEventListener('click', () => renderer.exportTrace());
        root.querySelector('[data-action="collapse-all"]').addEventListener('click', () => renderer.collapseAll());
        root.querySelector('.panel-backdrop').addEventListener('click', () => {
            setState('closed');
            showPill();
        });

        mounted = true;
    }

    function panelIsOpen() {
        return document.getElementById(rootId)?.dataset.state === 'open';
    }

    function idlePillView() {
        return { visible: false, text: '', tone: 'running', loading: false, detail: '' };
    }

    function currentPillView() {
        const run = store.getCurrentRun();
        if (!run) return idlePillView();
        if (pillFormatter) {
            return { ...idlePillView(), ...(pillFormatter(run, t) || { visible: false }) };
        }
        if (run.status !== 'running') return idlePillView();
        const sec = ((performance.now() - run.startedAt) / 1000).toFixed(0);
        return { visible: true, text: `● ${t('running')} · ${sec}s · ${t('Click to reopen')}`, tone: 'running', loading: true, detail: '' };
    }

    function renderPill() {
        if (!pill) return;
        const view = currentPillView();
        pill.update(view);
        const run = store.getCurrentRun();
        const ticking = view.visible && run?.status === 'running';
        if (ticking && !pillTimer) pillTimer = setInterval(renderPill, 1000);
        else if (!ticking && pillTimer) { clearInterval(pillTimer); pillTimer = null; }
    }

    function showPill() {
        renderPill();
    }

    function hidePill() {
        if (pill) pill.update(idlePillView());
        if (pillTimer) { clearInterval(pillTimer); pillTimer = null; }
    }

    function open() {
        if (onOpen) {
            try { onOpen(); } catch (error) { console.error('[run-panel] onOpen threw', error); }
        }
        mountOnce();
        hidePill();
        const run = store.getCurrentRun();
        const body = document.getElementById(rootId)?.querySelector('.panel-body');
        if (body) {
            const stale = body.querySelector(':scope > .empty-state');
            if (stale) stale.remove();
        }
        if (!run && body) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = t(emptyStateText);
            body.appendChild(empty);
        }
        if (run && renderer && body && body.querySelector('.rounds-list')?.children.length === 0) {
            renderer.replayFromStore();
        }
        setState('open');
    }

    function init() {
        if (unsubscribe) return;
        unsubscribe = store.subscribe((event) => {
            if (event.type === EV.RUN_STARTED) {
                if (event.quiet) return;
                if (!autoOpen && !pillOnStart) return;
                const wasOpen = mounted && panelIsOpen();
                mountOnce();
                renderer.handle(event);
                if (autoOpen) {
                    setState('open');
                    hidePill();
                    return;
                }
                setState(wasOpen ? 'open' : 'closed');
                if (wasOpen) hidePill();
                else showPill();
                return;
            }
            if (!mounted) return;
            renderer.handle(event);
            if (event.type === EV.RUN_FINISHED || event.type === EV.RUN_CLEARED) {
                if (panelIsOpen()) hidePill();
                else showPill();
                return;
            }
            if (pillOnStart && !panelIsOpen()) renderPill();
        });
    }

    function destroy() {
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        if (layoutMql && layoutHandler) {
            layoutMql.removeEventListener('change', layoutHandler);
            layoutMql = null;
            layoutHandler = null;
        }
        if (renderer && typeof renderer.destroy === 'function') renderer.destroy();
        hidePill();
        if (pill) { pill.destroy(); pill = null; }
        const root = document.getElementById(rootId);
        if (root) root.remove();
        const css = document.getElementById(cssId);
        if (css) css.remove();
        mounted = false;
        renderer = null;
    }

    return {
        init,
        open,
        destroy,
        refreshPill: () => {
            if (!panelIsOpen()) renderPill();
        },
    };
}
