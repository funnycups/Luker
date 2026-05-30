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
    // and cleanupSelectionUi out from under the closures, so the latest
    // mount's state is what the submit/cancel paths observe.
    let engine = null;
    let cleanupSelectionUi = null;

    function mountContent(currentPayload) {
        // Tear down the previous mount's listeners + DOM. Annotations on
        // the old chain are dropped because the chain itself has been
        // replaced — keeping them would re-anchor against text that no
        // longer exists in the DOM.
        if (cleanupSelectionUi) {
            try { cleanupSelectionUi(); } catch (_) { /* best-effort */ }
            cleanupSelectionUi = null;
        }
        while (contentRoot.firstChild) {
            contentRoot.removeChild(contentRoot.firstChild);
        }

        // Hint banner sits above the controls bar so users land on it
        // before scanning the rendered output. Without this, mobile
        // users miss the annotation affordance entirely (the float
        // button only appears after they select text) and desktop
        // users sometimes assume the popup is read-only.
        const hint = document.createElement('div');
        hint.className = 'luker-sim-hint';
        hint.textContent = i18n(
            'sim.hint.how_to_annotate',
            'Select any text below and tap "+ Add note" to annotate. Use Re-run if you want a fresh take.',
        );
        contentRoot.appendChild(hint);

        // Controls bar (re-run + expand/collapse toggle). Recreated on
        // each mount so the disabled state and labels start fresh after
        // a successful re-run. `bar` may be null in tests / contexts
        // where onRerun is not provided — in that case we still want
        // the expand/collapse toggle, so we always build a bar.
        const renderedNode = renderer(currentPayload, i18n);
        const bar = createControlsBar({
            onRerun,
            i18n,
            onSuccess: (next) => mountContent(next.payload),
            getHostNode: () => renderedNode,
        });
        contentRoot.appendChild(bar);

        contentRoot.appendChild(renderedNode);
        const annotationHost = renderedNode;
        engine = createAnnotationEngine({
            host: annotationHost,
            onAnnotationCreated: (annotation, markEl) => {
                insertAnnotationChip(annotation, markEl, engine, i18n);
            },
            onAnnotationDeleted: (id) => {
                removeChipForAnnotation(annotationHost, id);
            },
        });
        cleanupSelectionUi = attachSelectionUi(annotationHost, engine, i18n);
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
            if (cleanupSelectionUi) cleanupSelectionUi();
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
        if (cleanupSelectionUi) cleanupSelectionUi();
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

function createControlsBar({ onRerun, i18n, onSuccess, getHostNode }) {
    const bar = document.createElement('div');
    bar.className = 'luker-sim-rerun-bar';

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

function attachSelectionUi(host, engine, i18n) {
    let floatBtn = null;
    function clearFloat() {
        if (floatBtn && floatBtn.parentNode) floatBtn.parentNode.removeChild(floatBtn);
        floatBtn = null;
    }
    function showFloatAtSelection() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { clearFloat(); return; }
        const range = sel.getRangeAt(0);
        if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) { clearFloat(); return; }
        // `getBoundingClientRect` on Range is what positions the float
        // button. jsdom doesn't implement it; we still want the button
        // to exist (for clicks / tests) so we fall back to a fixed
        // top-left corner when the rect can't be computed.
        let rect = null;
        try {
            if (typeof range.getBoundingClientRect === 'function') {
                rect = range.getBoundingClientRect();
            }
        } catch (_) { /* layout not implemented (e.g. jsdom) */ }
        if (!floatBtn) {
            floatBtn = document.createElement('button');
            floatBtn.type = 'button';
            floatBtn.className = 'luker-sim-float-btn';
            floatBtn.textContent = i18n('sim.action.add_note', '+ Add note');
            document.body.appendChild(floatBtn);
        }
        // Clamp the float button into the viewport. Without this, a
        // selection that starts at the top of the popup body pushes
        // `rect.top - 36` into a negative number and the button
        // renders off-screen. Mobile keyboards / browser chrome can
        // also occlude near-edge positions, so we leave 8px of
        // breathing room on each side.
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const rectTop = rect ? rect.top : 8;
        const rectLeft = rect ? rect.left : 8;
        const desiredTop = rectTop - 36;
        const top = Math.max(8, desiredTop);
        const left = Math.max(8, Math.min(viewportWidth - 140, rectLeft));
        floatBtn.style.position = 'fixed';
        floatBtn.style.top = `${top}px`;
        floatBtn.style.left = `${left}px`;
        floatBtn.onmousedown = (e) => {
            // Stop the browser from collapsing the selection when the
            // button receives focus on mousedown — without this,
            // clicking the button kills the range we're about to
            // capture.
            e.preventDefault();
        };
        floatBtn.onclick = () => {
            const liveSel = window.getSelection();
            if (!liveSel || liveSel.rangeCount === 0) { clearFloat(); return; }
            // Snapshot the range BEFORE opening the prompt. iOS and
            // Android system menus dismiss the current selection when
            // window.prompt opens, so we have to keep our own copy and
            // re-apply it before handing off to the annotation engine.
            const snapshot = liveSel.getRangeAt(0).cloneRange();
            promptForCommentAndAdd(snapshot, engine, i18n, clearFloat);
        };
    }
    function onSelectionChange() {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
            clearFloat();
            return;
        }
        // Show the button whenever the selection lands inside the
        // host. This is the unified path for desktop mouse, mobile
        // touch, and keyboard selection — `selectionchange` fires for
        // all three, while `mouseup` / `touchend` are belt-and-
        // suspenders for environments where selectionchange is
        // throttled or doesn't fire (some embedded webviews).
        showFloatAtSelection();
    }
    host.addEventListener('mouseup', showFloatAtSelection);
    host.addEventListener('touchend', showFloatAtSelection);
    document.addEventListener('selectionchange', onSelectionChange);
    return function cleanup() {
        clearFloat();
        host.removeEventListener('mouseup', showFloatAtSelection);
        host.removeEventListener('touchend', showFloatAtSelection);
        document.removeEventListener('selectionchange', onSelectionChange);
    };
}

function promptForCommentAndAdd(range, engine, i18n, onDone) {
    const comment = window.prompt(i18n('sim.prompt.comment', 'Comment:'));
    if (typeof comment === 'string' && comment.trim()) {
        try {
            // Restore the range as the current selection before handing
            // off — the annotation engine reads from window.getSelection,
            // and on mobile the prompt has already dismissed the live
            // selection.
            const sel = window.getSelection();
            try {
                sel.removeAllRanges();
                sel.addRange(range);
            } catch (rangeErr) {
                console.warn('[simulation-review/popup] could not restore selection range', rangeErr);
            }
            engine.addAnnotationFromSelection(sel, comment.trim());
        } catch (err) {
            console.warn('[simulation-review/popup] add annotation failed', err);
            const fallback = i18n('sim.error.cant_annotate', 'Cannot annotate this selection.');
            const detail = err && err.message ? String(err.message) : '';
            try {
                window.alert(detail ? `${fallback} ${detail}` : fallback);
            } catch (alertErr) {
                // jsdom or restricted contexts may not implement alert; logging is enough.
                console.warn('[simulation-review/popup] alert unavailable', alertErr);
            }
        }
    }
    onDone();
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

function insertAnnotationChip(annotation, markEl, engine, i18n) {
    if (!markEl || !markEl.parentNode) return null;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'luker-sim-ann-chip';
    chip.setAttribute('data-ann-id', String(annotation.id));
    chip.textContent = `[${annotation.id}]`;
    chip.title = annotation.comment || '';
    chip.onclick = (e) => {
        e.stopPropagation();
        const current = engine.getAnnotations().find(a => a.id === annotation.id);
        if (!current) return;
        const editChoice = window.confirm(
            i18n('sim.prompt.annotation_action', 'Edit (OK) or delete (Cancel) this annotation?'),
        );
        if (editChoice) {
            const next = window.prompt(
                i18n('sim.prompt.edit_comment', 'Edit comment:'),
                current.comment || '',
            );
            if (next != null && next.trim()) {
                const trimmed = next.trim();
                engine.editAnnotation(annotation.id, trimmed);
                chip.title = trimmed;
            }
        } else {
            engine.deleteAnnotation(annotation.id);
        }
    };
    if (markEl.nextSibling) {
        markEl.parentNode.insertBefore(chip, markEl.nextSibling);
    } else {
        markEl.parentNode.appendChild(chip);
    }
    return chip;
}

function removeChipForAnnotation(host, id) {
    const chip = host.querySelector(`.luker-sim-ann-chip[data-ann-id="${id}"]`);
    if (chip && chip.parentNode) chip.parentNode.removeChild(chip);
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
