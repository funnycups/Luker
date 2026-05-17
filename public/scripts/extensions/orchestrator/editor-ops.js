/**
 * Orchestrator plugin-layer utilities on top of the message-takeover kernel.
 *
 * The kernel (`public/scripts/message-takeover.js`) exposes the minimal
 * `MessageEditorHandle` (getText / setText / commit / discard / ...). This
 * module builds the higher-level editing semantics — incremental append,
 * structured patches, stream pipes — that the orchestrator's director
 * runtime needs to drive multi-agent flows. None of these live in the
 * kernel; each is implementable atop `handle.setText` alone.
 */

export class EditorOpsError extends Error {
    constructor(code, message, { details = null } = {}) {
        super(message);
        this.name = 'EditorOpsError';
        this.code = code;
        this.details = details;
    }
}

function assertOffsetInRange(offset, max, { name = 'offset' } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || offset > max) {
        throw new EditorOpsError('invalid_offset', `${name} ${offset} out of range [0, ${max}]`, {
            details: { [name]: offset, max },
        });
    }
}

export function appendText(handle, text) {
    if (typeof text !== 'string') {
        throw new EditorOpsError('invalid_offset', `appendText requires a string, got ${typeof text}`);
    }
    handle.setText(handle.getText() + text);
}

export function appendReasoning(handle, text) {
    if (typeof text !== 'string') {
        throw new EditorOpsError('invalid_offset', `appendReasoning requires a string, got ${typeof text}`);
    }
    handle.setReasoning(handle.getReasoning() + text);
}

export function insertAt(handle, offset, text) {
    if (typeof text !== 'string') {
        throw new EditorOpsError('invalid_offset', `insertAt requires a string, got ${typeof text}`);
    }
    const current = handle.getText();
    assertOffsetInRange(offset, current.length);
    handle.setText(current.slice(0, offset) + text + current.slice(offset));
}

export function replaceRange(handle, start, end, text) {
    if (typeof text !== 'string') {
        throw new EditorOpsError('invalid_offset', `replaceRange requires a string, got ${typeof text}`);
    }
    const current = handle.getText();
    assertOffsetInRange(start, current.length, { name: 'start' });
    assertOffsetInRange(end, current.length, { name: 'end' });
    if (end < start) {
        throw new EditorOpsError('invalid_offset', `replaceRange end (${end}) must be >= start (${start})`, {
            details: { start, end },
        });
    }
    handle.setText(current.slice(0, start) + text + current.slice(end));
}

export function deleteRange(handle, start, end) {
    replaceRange(handle, start, end, '');
}

export function applyPatch(handle, patchOrPatches) {
    const list = Array.isArray(patchOrPatches) ? patchOrPatches : [patchOrPatches];
    for (const patch of list) {
        applySinglePatch(handle, patch);
    }
}

function applySinglePatch(handle, patch) {
    if (!patch || typeof patch !== 'object') {
        throw new EditorOpsError('invalid_offset', `patch must be an object, got ${typeof patch}`);
    }
    switch (patch.kind) {
        case 'replace_range':
            replaceRange(handle, patch.start, patch.end, patch.text);
            return;
        case 'insert_at':
            insertAt(handle, patch.offset, patch.text);
            return;
        case 'delete_range':
            replaceRange(handle, patch.start, patch.end, '');
            return;
        case 'context_replace':
            applyContextReplace(handle, patch);
            return;
        default:
            throw new EditorOpsError('invalid_offset', `unknown patch kind: ${patch.kind}`, {
                details: { kind: patch.kind },
            });
    }
}

function applyContextReplace(handle, patch) {
    const find = String(patch.find ?? '');
    if (!find) {
        throw new EditorOpsError('patch_not_found', 'context_replace.find must be a non-empty string', {
            details: { find: patch.find },
        });
    }
    const replaceWith = String(patch.replaceWith ?? '');

    const current = handle.getText();
    const firstIdx = current.indexOf(find);
    if (firstIdx === -1) {
        throw new EditorOpsError(
            'patch_not_found',
            'find string not present in current message body. The body may have been changed by an earlier patch — re-read getText() and produce a fresh `find` based on the current content.',
            { details: { find, replaceWith } },
        );
    }
    // Check for a second match — if there is one, the patch is ambiguous
    // by design. We do NOT accept an occurrence index: the standard way
    // codebase-edit LLM tools (Aider, Claude Code Edit, Cursor) resolve
    // ambiguity is to require the caller to expand `find` with surrounding
    // context until it is unique. Counting occurrences is error-prone for
    // models on long bodies and encourages the wrong habit.
    const secondIdx = current.indexOf(find, firstIdx + 1);
    if (secondIdx !== -1) {
        throw new EditorOpsError(
            'patch_ambiguous',
            'find string is not unique in the current message body. Extend the `find` string to include surrounding context (a few lines before and/or after the target) until it matches exactly one location.',
            { details: { find, replaceWith, firstMatch: firstIdx, secondMatch: secondIdx } },
        );
    }
    replaceRange(handle, firstIdx, firstIdx + find.length, replaceWith);
}

export function patchBySemantic(handle, spec) {
    applyPatch(handle, { kind: 'context_replace', ...spec });
}

/**
 * Pipe an AsyncIterable of stream chunks (from generateTaskStream) into the
 * editor. Text chunks append to message text; reasoning chunks append to
 * reasoning. mode='append' (default) preserves the current text as prefix;
 * mode='replace' first clears the text (kernel will reject during continue).
 *
 * Does NOT auto-commit; caller composes multiple pipes / patches and commits
 * explicitly.
 */
export async function pipeFrom(handle, stream, { mode = 'append' } = {}) {
    let textAccum;
    if (mode === 'replace') {
        handle.setText('');
        textAccum = '';
    } else if (mode === 'append') {
        textAccum = handle.getText();
    } else {
        throw new EditorOpsError('invalid_offset', `pipeFrom: unknown mode ${mode}`, { details: { mode } });
    }

    let reasoningAccum = handle.getReasoning();

    for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'text' && typeof chunk.delta === 'string') {
            textAccum += chunk.delta;
            handle.setText(textAccum);
        } else if (chunk.type === 'reasoning' && typeof chunk.delta === 'string') {
            reasoningAccum += chunk.delta;
            handle.setReasoning(reasoningAccum);
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Named-section helpers for the reasoning fold.
//
// When a plugin runs multiple concurrent producers (e.g. director's
// sub-agents streaming in parallel) and wants each producer's output to
// land in its OWN visible region of the reasoning fold — not interleaved
// at the character level — these helpers anchor each producer to a
// stable section header and let chunk handlers splice deltas into the
// correct section.
//
// Section header format:
//
//   ### [<id>] (<optional status>)
//
// `id` MUST be unique across all concurrently-live sections in a single
// reasoning fold (use the dispatch handle id, not the human-readable
// agent name). Two sections with the same id will interleave.
//
// Race-freedom: every helper performs the read-modify-write of the
// reasoning string SYNCHRONOUSLY (no `await` between getReasoning and
// setReasoning). JavaScript's single-threaded event loop guarantees that
// two stream chunk handlers cannot interleave inside a single helper
// call — each handler completes its read-modify-write atomically before
// any other handler runs. Consumers MUST NOT keep a stale read of the
// reasoning string across helper calls.
// ──────────────────────────────────────────────────────────────────────────

function sectionHeader(id, status) {
    const safeId = String(id ?? '').trim();
    if (!safeId) {
        throw new EditorOpsError('invalid_offset', 'section id must be a non-empty string', { details: { id } });
    }
    const safeStatus = String(status ?? '').trim();
    return safeStatus ? `### [${safeId}] (${safeStatus})` : `### [${safeId}]`;
}

function findSectionHeaderLine(reasoningText, id) {
    // Match `### [<id>]` (with optional ` (<status>)` suffix) at a line
    // start. Returns { headerStart, headerEnd } where headerEnd is one
    // past the newline ending the header line (or text length).
    const safeId = String(id ?? '');
    // Two candidate prefixes: header at file start, or after a newline.
    const candidates = [`### [${safeId}]`];
    for (const candidate of candidates) {
        let cursor = 0;
        while (cursor <= reasoningText.length - candidate.length) {
            const idx = reasoningText.indexOf(candidate, cursor);
            if (idx === -1) break;
            // Must be at a line start (idx === 0 or preceded by '\n').
            if (idx !== 0 && reasoningText.charAt(idx - 1) !== '\n') {
                cursor = idx + 1;
                continue;
            }
            // Header line continues until the next '\n' or text end.
            const eol = reasoningText.indexOf('\n', idx);
            const headerEnd = eol === -1 ? reasoningText.length : eol + 1;
            return { headerStart: idx, headerEnd };
        }
    }
    return null;
}

function findSectionEnd(reasoningText, headerEnd) {
    // Locate the end of the section's body. Body extends from headerEnd
    // up to (but not including) any trailing newlines that act as the
    // blank-line separator before the next section header, or up to the
    // end of the text when this is the last section.
    let cursor = headerEnd;
    while (cursor <= reasoningText.length - 5) {
        const idx = reasoningText.indexOf('\n### [', cursor);
        if (idx === -1) break;
        // idx is the newline character before the next header. Walk back
        // over any preceding consecutive newlines (the separator block)
        // so that inserts land on the body's content boundary, not in
        // the middle of the separator.
        let bodyEnd = idx;
        while (bodyEnd > headerEnd && reasoningText.charAt(bodyEnd - 1) === '\n') {
            bodyEnd--;
        }
        return bodyEnd;
    }
    // No following section — body extends to text end, but also walk
    // back past trailing newlines so subsequent appends concatenate
    // cleanly instead of after a dangling blank line.
    let bodyEnd = reasoningText.length;
    while (bodyEnd > headerEnd && reasoningText.charAt(bodyEnd - 1) === '\n') {
        bodyEnd--;
    }
    return bodyEnd;
}

/**
 * Reserve a section at the end of the reasoning fold if it does not
 * already exist. Idempotent. Useful when the section's producer hasn't
 * emitted any output yet but you want a visible placeholder so the user
 * can see "this agent is working".
 */
export function ensureReasoningSection(handle, id, { status = 'running' } = {}) {
    const text = handle.getReasoning();
    if (findSectionHeaderLine(text, id)) return;
    // Normalize: strip trailing newlines so the separator is always
    // exactly `\n\n` (one blank line) between the previous content and
    // this new header. Without normalization, callers that append a
    // newline at the end of a body chunk + then ensure a new section
    // would accumulate extra blank lines.
    const normalized = text.replace(/\n+$/, '');
    const sep = normalized ? '\n\n' : '';
    handle.setReasoning(normalized + sep + sectionHeader(id, status) + '\n');
}

/**
 * Append `delta` to the body of the named section. Creates the section
 * if it does not yet exist (with the default running status). Multiple
 * concurrent chunk handlers calling this with different ids are safe to
 * interleave at the event-loop level; calls with the SAME id are also
 * safe as long as they remain on the same event loop (which they do
 * inside JS).
 */
export function appendToReasoningSection(handle, id, delta) {
    if (typeof delta !== 'string') {
        throw new EditorOpsError('invalid_offset', `appendToReasoningSection requires a string delta, got ${typeof delta}`);
    }
    if (!delta) return;
    const text = handle.getReasoning();
    const found = findSectionHeaderLine(text, id);
    if (!found) {
        // Section not yet present — create it at the end with the delta
        // as its initial body. This avoids losing chunks that arrive
        // before an explicit ensureReasoningSection call.
        const normalized = text.replace(/\n+$/, '');
        const sep = normalized ? '\n\n' : '';
        handle.setReasoning(normalized + sep + sectionHeader(id, 'running') + '\n' + delta);
        return;
    }
    const { headerEnd } = found;
    const sectionEnd = findSectionEnd(text, headerEnd);
    const before = text.slice(0, sectionEnd);
    const after = text.slice(sectionEnd);
    handle.setReasoning(before + delta + after);
}

/**
 * Update the section's status suffix. Pass `null` / `''` to clear the
 * suffix (typical "done" state). Throws if the section does not exist.
 */
export function markReasoningSectionStatus(handle, id, status) {
    const text = handle.getReasoning();
    const found = findSectionHeaderLine(text, id);
    if (!found) {
        throw new EditorOpsError('invalid_offset', `section "${id}" not found`, { details: { id } });
    }
    const { headerStart, headerEnd } = found;
    // headerEnd is one past the trailing newline (or text length when
    // section header is the last line). The header line itself runs from
    // headerStart up to either headerEnd-1 (if newline was found) or
    // headerEnd (if not).
    const headerLineEnd = headerEnd > 0 && text.charAt(headerEnd - 1) === '\n' ? headerEnd - 1 : headerEnd;
    const newHeaderLine = sectionHeader(id, status);
    handle.setReasoning(text.slice(0, headerStart) + newHeaderLine + text.slice(headerLineEnd));
}
