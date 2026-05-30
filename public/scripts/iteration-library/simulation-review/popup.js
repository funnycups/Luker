// Drives the simulation-review popup lifecycle. Picks the renderer by
// kind, wires the annotation engine to the rendered DOM, plumbs the
// submit/cancel actions back through a Promise that the caller awaits.

import { render as renderCeaCpa } from './renderers/cea-cpa.js';
import { render as renderSpec } from './renderers/orchestrator-spec.js';
import { render as renderAgenda } from './renderers/orchestrator-agenda.js';
import { render as renderLoop } from './renderers/orchestrator-loop.js';
import { render as renderDirector } from './renderers/orchestrator-director.js';
import { createAnnotationEngine } from './annotation-engine.js';
import { openHostPopup } from './popup-host.js';

const RENDERERS = {
    'cea': renderCeaCpa,
    'cpa': renderCeaCpa,
    'orch-spec': renderSpec,
    'orch-agenda': renderAgenda,
    'orch-loop': renderLoop,
    'orch-director': renderDirector,
};

const TITLES = {
    'cea': 'sim.title.cea',
    'cpa': 'sim.title.cpa',
    'orch-spec': 'sim.title.orch_spec',
    'orch-agenda': 'sim.title.orch_agenda',
    'orch-loop': 'sim.title.orch_loop',
    'orch-director': 'sim.title.orch_director',
};

const TITLE_FALLBACK = {
    'cea': 'Simulation Review — Character Card',
    'cpa': 'Simulation Review — Preset',
    'orch-spec': 'Simulation Review — Orchestrator (Spec)',
    'orch-agenda': 'Simulation Review — Orchestrator (Agenda)',
    'orch-loop': 'Simulation Review — Orchestrator (Loop)',
    'orch-director': 'Simulation Review — Orchestrator (Director)',
};

let isOpen = false;

/**
 * @param {{
 *   kind: string,
 *   payload: any,
 *   i18n: (key: string, fallback?: string) => string,
 *   abortSignal?: AbortSignal,
 *   onRerun?: () => Promise<{ payload: any } | null>,
 * }} args
 * @returns {Promise<{ok: boolean, cancelled: boolean, chainSegments: any[], annotations: any[]}>}
 */
export async function openSimulationReview({ kind, payload, i18n, abortSignal, onRerun }) {
    if (isOpen) {
        const err = new Error('simulate_in_progress');
        err.code = 'simulate_in_progress';
        throw err;
    }
    const renderer = RENDERERS[kind];
    if (!renderer) {
        const err = new Error(`Unknown simulation kind: ${kind}`);
        err.code = 'unknown_kind';
        throw err;
    }
    isOpen = true;

    const contentRoot = document.createElement('div');
    contentRoot.className = 'luker-sim-review-host';

    // Mutable state read by buildSubmitResult / buildCancelResult at popup
    // close and by mountContent() at each (re-)mount. Re-runs swap engine
    // and annotation listener out from under the closures, so the latest
    // mount's state is what the submit/cancel paths observe.
    let engine = null;
    let cleanupAnnotationListener = null;

    function mountContent(currentPayload) {
        // Tear down the previous mount's listeners + DOM. Annotations on
        // the old chain are dropped because the chain itself has been
        // replaced — keeping them would re-anchor against text that no
        // longer exists in the DOM.
        if (cleanupAnnotationListener) {
            try { cleanupAnnotationListener(); } catch (_) { /* best-effort */ }
            cleanupAnnotationListener = null;
        }
        while (contentRoot.firstChild) {
            contentRoot.removeChild(contentRoot.firstChild);
        }

        // Controls bar (annotation toggle + re-run + expand/collapse).
        // Rebuilt on each mount so the toggle starts in "off" state
        // and the disabled state / labels start fresh after a
        // successful re-run.
        const renderedNode = renderer(currentPayload, i18n);
        const annotationHost = renderedNode;
        const bar = createControlsBar({
            onRerun,
            i18n,
            annotationHost,
            onSuccess: (next) => mountContent(next.payload),
            getHostNode: () => renderedNode,
        });
        contentRoot.appendChild(bar);

        contentRoot.appendChild(renderedNode);
        engine = createAnnotationEngine({
            host: annotationHost,
            i18n,
        });
        cleanupAnnotationListener = attachAnnotationListener(annotationHost, engine);
        attachCollapseToggles(annotationHost);

        // Auto-scroll the final-output section into view so the popup
        // opens with the most relevant content visible — director's 11
        // rounds of sub-agent chatter make the popup unreadable
        // otherwise. We schedule via rAF so the layout is settled.
        scheduleScrollToFinalOutput(contentRoot, renderedNode);
    }

    mountContent(payload);

    let aborted = false;
    const onAbort = () => { aborted = true; };
    if (abortSignal) {
        if (abortSignal.aborted) {
            isOpen = false;
            if (cleanupAnnotationListener) cleanupAnnotationListener();
            const err = new Error('aborted_by_user');
            err.code = 'aborted_by_user';
            throw err;
        }
        abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    try {
        const result = await openHostPopup({
            title: i18n(TITLES[kind], TITLE_FALLBACK[kind]),
            contentRoot,
            onSubmit: () => buildSubmitResult(engine),
            onCancel: () => buildCancelResult(engine),
            i18n,
            abortSignal,
        });
        if (aborted) {
            const err = new Error('aborted_by_user');
            err.code = 'aborted_by_user';
            throw err;
        }
        return result;
    } finally {
        isOpen = false;
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        if (cleanupAnnotationListener) cleanupAnnotationListener();
    }
}

function buildSubmitResult(engine) {
    const annotations = engine.getAnnotations();
    const chainSegments = engine.buildChainSegments();
    return { ok: true, cancelled: false, annotations, chainSegments };
}

function buildCancelResult(engine) {
    const chainSegments = engine.buildChainSegments().map(s => ({ text: s.text }));
    return { ok: false, cancelled: true, annotations: [], chainSegments };
}

function createControlsBar({ onRerun, i18n, annotationHost, onSuccess, getHostNode }) {
    const bar = document.createElement('div');
    bar.className = 'luker-sim-rerun-bar';

    // Annotation-mode toggle. When ON, the host element flips
    // `data-annot-mode="on"` which the pointerup listener gates on:
    // selecting text creates a <mark> and clears the selection so the
    // mobile system menu (iOS Copy/Look up) doesn't preempt the UI.
    // When OFF the host behaves as plain readable text — selection
    // and copy work normally with no annotation side-effects.
    const annotBtn = document.createElement('button');
    annotBtn.type = 'button';
    annotBtn.classList.add('menu_button', 'sim-review-annot-toggle');
    annotBtn.dataset.state = 'off';
    annotBtn.textContent = i18n('sim.action.annotation_mode', 'Annotation mode');
    annotBtn.title = i18n('sim.hint.annotation_mode_off', 'Turn on to annotate by selecting text.');
    annotationHost.dataset.annotMode = 'off';
    annotBtn.addEventListener('click', () => {
        const on = annotBtn.dataset.state !== 'on';
        annotBtn.dataset.state = on ? 'on' : 'off';
        annotBtn.classList.toggle('is-on', on);
        annotBtn.title = on
            ? i18n('sim.hint.annotation_mode_on', 'Select text in the preview to annotate it.')
            : i18n('sim.hint.annotation_mode_off', 'Turn on to annotate by selecting text.');
        annotationHost.dataset.annotMode = on ? 'on' : 'off';
    });
    bar.appendChild(annotBtn);

    // Expand all / Collapse all toggle. Walks every section marked
    // data-collapsible="true" (set by the shared appendShared helper
    // when opts.collapsedByDefault was passed). The final-output
    // section is never collapsible, so this toggle leaves it
    // untouched. The label flips based on the current state: if
    // ANY collapsible section is currently collapsed, the button
    // reads "Expand all" and clicking expands everything; otherwise
    // it reads "Collapse all" and clicking re-collapses.
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'luker-sim-toggle-btn';
    function updateToggleLabel() {
        const host = typeof getHostNode === 'function' ? getHostNode() : null;
        if (!host) {
            toggleBtn.textContent = i18n('sim.action.expand_all', 'Expand all');
            return;
        }
        const collapsibles = host.querySelectorAll('[data-collapsible="true"]');
        const anyCollapsed = Array.from(collapsibles).some(s => s.classList.contains('luker-sim-section--collapsed'));
        toggleBtn.textContent = anyCollapsed
            ? i18n('sim.action.expand_all', 'Expand all')
            : i18n('sim.action.collapse_all', 'Collapse all');
    }
    updateToggleLabel();
    toggleBtn.onclick = () => {
        const host = typeof getHostNode === 'function' ? getHostNode() : null;
        if (!host) return;
        const collapsibles = host.querySelectorAll('[data-collapsible="true"]');
        const anyCollapsed = Array.from(collapsibles).some(s => s.classList.contains('luker-sim-section--collapsed'));
        if (anyCollapsed) {
            collapsibles.forEach(s => s.classList.remove('luker-sim-section--collapsed'));
        } else {
            collapsibles.forEach(s => s.classList.add('luker-sim-section--collapsed'));
        }
        updateToggleLabel();
    };
    bar.appendChild(toggleBtn);

    // Re-run button — same lifecycle as before. Skipped when the
    // caller didn't provide an onRerun closure (e.g. test fixtures
    // that don't exercise the re-run path).
    if (typeof onRerun === 'function') {
        const rerunBtn = document.createElement('button');
        rerunBtn.type = 'button';
        rerunBtn.className = 'luker-sim-rerun-btn';
        const initialLabel = i18n('sim.action.rerun', '↻ Re-run simulation');
        rerunBtn.textContent = initialLabel;
        rerunBtn.onclick = async () => {
            if (rerunBtn.disabled) return;
            rerunBtn.disabled = true;
            rerunBtn.textContent = i18n('sim.action.rerun_running', 'Re-running…');
            try {
                const next = await onRerun();
                if (next && next.payload) {
                    onSuccess(next);
                    // onSuccess re-mounts contentRoot, which discards
                    // this bar; restoring btn state below would touch
                    // a detached node. Bail before the `finally`.
                    return;
                }
            } catch (err) {
                console.warn('[simulation-review/popup] re-run failed', err);
                const prefix = i18n('sim.error.rerun_failed', 'Re-run failed.');
                const detail = err && err.message ? String(err.message) : '';
                try {
                    window.alert(detail ? `${prefix} ${detail}` : prefix);
                } catch (alertErr) {
                    // jsdom or restricted contexts may not implement alert.
                    console.warn('[simulation-review/popup] alert unavailable', alertErr);
                }
            }
            rerunBtn.disabled = false;
            rerunBtn.textContent = initialLabel;
        };
        bar.appendChild(rerunBtn);
    }

    return bar;
}

function attachAnnotationListener(host, engine) {
    // Pointerup is the unified entry for mouse, touch, and pen. We gate
    // on the host's data-annot-mode flag (set by the toggle button) so
    // that selecting text when the mode is off behaves like plain
    // selection — no annotation, no DOM mutation, no preempted iOS
    // system menu.
    function onPointerUp(ev) {
        if (host.dataset.annotMode !== 'on') return;
        // Ignore clicks on the inline × remove button — it handles its
        // own removal via the engine and we don't want to immediately
        // re-annotate the (now-empty) selection underneath.
        if (ev && ev.target && ev.target.closest && ev.target.closest('.sim-review-annot-remove')) {
            return;
        }
        const selection = host.ownerDocument?.getSelection?.() ?? document.getSelection();
        if (!selection || selection.isCollapsed) return;
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (!range || range.collapsed) return;
        if (!host.contains(range.commonAncestorContainer)) return;
        try {
            // Empty comment — the new UX is "highlight to mark, × to
            // remove" without a comment prompt. The feedback-builder
            // still emits the annotation in the chain segments.
            engine.addAnnotationFromSelection(selection, '');
        } catch (err) {
            // Engine errors (cross-element boundary, overlap, etc.) are
            // expected when users pick awkward ranges. We swallow them
            // so the popup doesn't pop a console warning on every
            // edge-of-paragraph drag.
            console.debug('[simulation-review/popup] annotation skipped', err && err.message);
        }
        try {
            selection.removeAllRanges();
        } catch (_) { /* ignore: jsdom restricted contexts */ }
    }
    host.addEventListener('pointerup', onPointerUp);
    return function cleanup() {
        host.removeEventListener('pointerup', onPointerUp);
    };
}

function scheduleScrollToFinalOutput(scrollContainer, renderedNode) {
    // Defer scroll to after layout so getBoundingClientRect /
    // scrollIntoView see settled positions. requestAnimationFrame is
    // the canonical hook; in jsdom it's polyfilled to setTimeout(0)
    // which is fine for tests.
    const schedule = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame
        : ((cb) => setTimeout(cb, 0));
    schedule(() => {
        try {
            const target = renderedNode.querySelector('[data-sim-final-output="true"]');
            if (target && typeof target.scrollIntoView === 'function') {
                target.scrollIntoView({ behavior: 'auto', block: 'start' });
            }
        } catch (err) {
            console.warn('[simulation-review/popup] auto-scroll failed', err);
        }
    });
}

function attachCollapseToggles(host) {
    host.addEventListener('click', (e) => {
        // Only react to header clicks within collapsible sections.
        const header = e.target.closest('h1, h2, h3, h4');
        if (!header) return;
        const section = header.parentElement;
        if (!section) return;
        if (!section.classList.contains('luker-sim-section')
            && !section.classList.contains('luker-sim-subsection')
            && !section.classList.contains('luker-sim-subsubsection')) {
            return;
        }
        section.classList.toggle('luker-sim-section--collapsed');
    });
}
