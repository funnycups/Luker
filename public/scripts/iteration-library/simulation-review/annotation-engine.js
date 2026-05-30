// Annotation engine for the simulation-review popup. Owns:
//   - selection → path resolution (walks up to nearest [data-loc-path])
//   - addAnnotationFromSelection: wrap range in <mark class="luker-sim-annotation">
//   - editAnnotation, deleteAnnotation
//   - buildChainSegments: snapshot the host's text into segments with
//     optional annotationId for the feedback-builder.
//
// No popup chrome here; that lives in popup.js. This module is the
// state owner so we can unit-test it under jsdom.

const ANN_CLASS = 'luker-sim-annotation';
const ANN_ATTR = 'data-ann-id';
const ANN_REMOVE_CLASS = 'sim-review-annot-remove';
const ANN_COMMENT_CLASS = 'sim-review-annot-comment';

/**
 * @param {{
 *   host: HTMLElement,
 *   i18n?: (key: string, fallback?: string) => string,
 *   onStateChange?: (state: Map<number, Annotation>) => void,
 *   onAnnotationCreated?: (annotation: {id:number,snippet:string,comment:string,path:string}, markEl: HTMLElement) => void,
 *   onAnnotationDeleted?: (id: number) => void,
 * }} opts
 */
export function createAnnotationEngine({
    host,
    i18n = (_, fallback) => (fallback ?? ''),
    onStateChange = null,
    onAnnotationCreated = null,
    onAnnotationDeleted = null,
}) {
    if (!host || !(host instanceof HTMLElement)) {
        throw new Error('annotation-engine requires host HTMLElement');
    }
    const state = new Map(); // id -> { id, snippet, comment, path, markEl }
    let nextId = 1;

    function notify() {
        if (typeof onStateChange === 'function') {
            try {
                onStateChange(state);
            } catch (err) {
                console.warn('[simulation-review/annotation-engine] onStateChange threw', err);
            }
        }
    }

    function resolvePathForSelection(selection) {
        if (!selection || selection.rangeCount === 0) {
            return '(unknown)';
        }
        const range = selection.getRangeAt(0);
        let node = range.startContainer;
        if (node && node.nodeType === Node.TEXT_NODE) {
            node = node.parentElement;
        }
        while (node && node !== host) {
            if (node.nodeType === Node.ELEMENT_NODE && node.hasAttribute('data-loc-path')) {
                return node.getAttribute('data-loc-path');
            }
            node = node.parentElement;
        }
        return '(unknown)';
    }

    function isWithinHost(node) {
        let cur = node;
        while (cur) {
            if (cur === host) return true;
            cur = cur.parentNode;
        }
        return false;
    }

    function selectionOverlapsExistingAnnotation(range) {
        const marks = host.querySelectorAll(`mark.${ANN_CLASS}`);
        for (const m of marks) {
            const r = document.createRange();
            r.selectNodeContents(m);
            if (range.compareBoundaryPoints(Range.END_TO_START, r) < 0
                && range.compareBoundaryPoints(Range.START_TO_END, r) > 0) {
                return true;
            }
        }
        return false;
    }

    function addAnnotationFromSelection(selection, comment) {
        if (!selection || selection.rangeCount === 0) {
            throw new Error('No selection');
        }
        const range = selection.getRangeAt(0);
        if (range.collapsed || range.toString().length === 0) {
            throw new Error('Selection is empty');
        }
        if (!isWithinHost(range.startContainer) || !isWithinHost(range.endContainer)) {
            throw new Error('Selection escapes host');
        }
        if (selectionOverlapsExistingAnnotation(range)) {
            throw new Error('Selection overlaps an existing annotation');
        }
        const snippet = range.toString();
        const path = resolvePathForSelection(selection);
        const id = nextId++;
        const mark = document.createElement('mark');
        mark.className = ANN_CLASS;
        mark.setAttribute(ANN_ATTR, String(id));
        try {
            range.surroundContents(mark);
        } catch (err) {
            if (err && err.name === 'InvalidStateError') {
                throw new Error('Selection crosses element boundaries; pick a span within a single block.');
            }
            throw err;
        }
        // Inline × that removes this annotation. Lives inside the
        // <mark> so the affordance travels with the highlight on
        // mobile (no floating button to mis-position when the
        // viewport scrolls).
        const removeBtn = mark.ownerDocument.createElement('button');
        removeBtn.type = 'button';
        removeBtn.classList.add(ANN_REMOVE_CLASS);
        removeBtn.setAttribute('aria-label', i18n('sim.action.remove_annotation', 'Remove annotation'));
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            deleteAnnotation(id);
        });
        mark.appendChild(removeBtn);

        // Inline comment input lives next to the × so users can type
        // a rationale right on the highlight. Every keystroke flows
        // through editAnnotation() into the engine's record, so
        // submit-time getAnnotations() reflects whatever is currently
        // typed without needing an explicit blur/commit. The
        // pointerdown / click handlers stop propagation so tapping
        // the field doesn't trigger the surrounding selection / annot
        // pipeline on touch devices.
        const commentInput = mark.ownerDocument.createElement('input');
        commentInput.type = 'text';
        commentInput.classList.add(ANN_COMMENT_CLASS);
        commentInput.placeholder = i18n('sim.action.comment_placeholder', 'Comment (optional)');
        commentInput.value = String(comment || '');
        commentInput.addEventListener('input', (ev) => {
            ev.stopPropagation();
            editAnnotation(id, commentInput.value);
        });
        ['pointerdown', 'mousedown', 'click'].forEach((evName) => {
            commentInput.addEventListener(evName, (ev) => ev.stopPropagation());
        });
        mark.appendChild(commentInput);
        selection.removeAllRanges();
        const record = { id, snippet, comment: String(comment || ''), path, markEl: mark };
        state.set(id, record);
        const summary = { id, snippet, comment: record.comment, path };
        notify();
        if (typeof onAnnotationCreated === 'function') {
            try {
                onAnnotationCreated(summary, mark);
            } catch (err) {
                console.warn('[simulation-review/annotation-engine] onAnnotationCreated threw', err);
            }
        }
        return summary;
    }

    function editAnnotation(id, comment) {
        const rec = state.get(id);
        if (!rec) return false;
        rec.comment = String(comment || '');
        notify();
        return true;
    }

    function deleteAnnotation(id) {
        const rec = state.get(id);
        if (!rec) return false;
        const mark = rec.markEl;
        if (mark && mark.parentNode) {
            // Strip the × control and the inline comment input before
            // unwrap so neither bleeds into the surrounding text — and
            // so re-runs that snapshot segments don't see a stray "×"
            // glyph or the input element itself in the DOM.
            const removeBtn = mark.querySelector(`.${ANN_REMOVE_CLASS}`);
            if (removeBtn && removeBtn.parentNode === mark) {
                mark.removeChild(removeBtn);
            }
            const commentInput = mark.querySelector(`.${ANN_COMMENT_CLASS}`);
            if (commentInput && commentInput.parentNode === mark) {
                mark.removeChild(commentInput);
            }
            const parent = mark.parentNode;
            while (mark.firstChild) {
                parent.insertBefore(mark.firstChild, mark);
            }
            parent.removeChild(mark);
            parent.normalize();
        }
        state.delete(id);
        notify();
        if (typeof onAnnotationDeleted === 'function') {
            try {
                onAnnotationDeleted(id);
            } catch (err) {
                console.warn('[simulation-review/annotation-engine] onAnnotationDeleted threw', err);
            }
        }
        return true;
    }

    function getAnnotations() {
        return Array.from(state.values()).map(r => ({
            id: r.id,
            snippet: r.snippet,
            comment: r.comment,
            path: r.path,
        }));
    }

    function buildChainSegments() {
        const segments = [];
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                // Skip text inside the inline × control and the inline
                // comment input so neither the literal "×" glyph nor
                // the user's typed feedback leaks into the chain that
                // ships to the workbench LLM. (The input's value is
                // surfaced via the structured <annotations> block in
                // feedback-builder, not via inline chain segments.)
                let p = node.parentElement;
                while (p && p !== host) {
                    if (p.classList) {
                        if (p.classList.contains(ANN_REMOVE_CLASS)) return NodeFilter.FILTER_REJECT;
                        if (p.classList.contains(ANN_COMMENT_CLASS)) return NodeFilter.FILTER_REJECT;
                    }
                    p = p.parentElement;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        let n;
        while ((n = walker.nextNode())) {
            const text = n.nodeValue;
            if (!text) continue;
            let p = n.parentElement;
            let annotationId;
            while (p && p !== host) {
                if (p.tagName === 'MARK' && p.classList.contains(ANN_CLASS)) {
                    annotationId = Number(p.getAttribute(ANN_ATTR));
                    break;
                }
                p = p.parentElement;
            }
            const seg = { text };
            if (Number.isFinite(annotationId) && annotationId > 0) {
                seg.annotationId = annotationId;
            }
            segments.push(seg);
        }
        // Coalesce consecutive non-annotated text segments and merge consecutive
        // same-annotation segments. Keeps the output compact.
        const merged = [];
        for (const seg of segments) {
            const last = merged[merged.length - 1];
            if (last && last.annotationId === seg.annotationId) {
                last.text += seg.text;
            } else {
                merged.push({ ...seg });
            }
        }
        return merged;
    }

    return {
        resolvePathForSelection,
        addAnnotationFromSelection,
        editAnnotation,
        deleteAnnotation,
        getAnnotations,
        buildChainSegments,
    };
}
