/**
 * Orchestrator plugin-layer utilities on top of the message-takeover kernel.
 *
 * The kernel (`public/scripts/message-takeover.js`) exposes the minimal
 * `MessageEditorHandle` (getText / setText / commit / abort / discard / ...).
 * This module builds the higher-level editing semantics — incremental append,
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
    const oldString = String(patch.oldString ?? '');
    if (!oldString) {
        throw new EditorOpsError('patch_not_found', 'context_replace.oldString must be a non-empty string', {
            details: { oldString: patch.oldString },
        });
    }
    const newString = String(patch.newString ?? '');

    const current = handle.getText();
    const firstIdx = current.indexOf(oldString);
    if (firstIdx === -1) {
        throw new EditorOpsError(
            'patch_not_found',
            'oldString not present in current message body. The body may have been changed by an earlier patch — re-read getText() and produce a fresh `oldString` based on the current content.',
            { details: { oldString, newString } },
        );
    }
    // Check for a second match — if there is one, the patch is ambiguous
    // by design. We do NOT accept an occurrence index: the standard way
    // codebase-edit LLM tools (Aider, Claude Code Edit, Cursor) resolve
    // ambiguity is to require the caller to expand `oldString` with
    // surrounding context until it is unique. Counting occurrences is
    // error-prone for models on long bodies and encourages the wrong habit.
    const secondIdx = current.indexOf(oldString, firstIdx + 1);
    if (secondIdx !== -1) {
        throw new EditorOpsError(
            'patch_ambiguous',
            'oldString is not unique in the current message body. Extend it to include surrounding context (a few lines before and/or after the target) until it matches exactly one location.',
            { details: { oldString, newString, firstMatch: firstIdx, secondMatch: secondIdx } },
        );
    }
    replaceRange(handle, firstIdx, firstIdx + oldString.length, newString);
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
