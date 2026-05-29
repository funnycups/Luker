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
 * }} args
 * @returns {Promise<{ok: boolean, cancelled: boolean, chainSegments: any[], annotations: any[]}>}
 */
export async function openSimulationReview({ kind, payload, i18n, abortSignal }) {
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
    const renderedNode = renderer(payload, i18n);
    contentRoot.appendChild(renderedNode);

    const annotationHost = renderedNode;
    // engine is closed-over by the callbacks; declare with `let` and
    // assign after the factory call so the callbacks can reach back into
    // the engine they belong to.
    let engine = null;
    engine = createAnnotationEngine({
        host: annotationHost,
        onAnnotationCreated: (annotation, markEl) => {
            insertAnnotationChip(annotation, markEl, engine, i18n);
        },
        onAnnotationDeleted: (id) => {
            removeChipForAnnotation(annotationHost, id);
        },
    });
    const cleanupSelectionUi = attachSelectionUi(annotationHost, engine, i18n);
    attachCollapseToggles(annotationHost);

    let aborted = false;
    const onAbort = () => { aborted = true; };
    if (abortSignal) {
        if (abortSignal.aborted) {
            isOpen = false;
            cleanupSelectionUi();
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
        cleanupSelectionUi();
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
        const rect = range.getBoundingClientRect();
        if (!floatBtn) {
            floatBtn = document.createElement('button');
            floatBtn.type = 'button';
            floatBtn.className = 'luker-sim-float-btn';
            floatBtn.textContent = i18n('sim.action.add_note', '+ Add note');
            document.body.appendChild(floatBtn);
        }
        floatBtn.style.position = 'fixed';
        floatBtn.style.top = `${rect.top - 32}px`;
        floatBtn.style.left = `${rect.left}px`;
        floatBtn.onclick = () => promptForCommentAndAdd(sel, engine, i18n, clearFloat);
    }
    function onSelectionChange() {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) clearFloat();
    }
    host.addEventListener('mouseup', showFloatAtSelection);
    document.addEventListener('selectionchange', onSelectionChange);
    return function cleanup() {
        clearFloat();
        host.removeEventListener('mouseup', showFloatAtSelection);
        document.removeEventListener('selectionchange', onSelectionChange);
    };
}

function promptForCommentAndAdd(selection, engine, i18n, onDone) {
    const comment = window.prompt(i18n('sim.prompt.comment', 'Comment:'));
    if (typeof comment === 'string' && comment.trim()) {
        try {
            engine.addAnnotationFromSelection(selection, comment.trim());
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
