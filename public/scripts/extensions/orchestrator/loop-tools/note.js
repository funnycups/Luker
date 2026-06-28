/**
 * loop-tools/note.js — note tools for loop mode.
 *
 * Two tools, both addressed by stable note id:
 *
 *   - `note_open` appends a free-form note (per-chat, cross-run). New notes
 *     are persisted with `status: 'open'` and surface in the agent's
 *     `## Open Notes` prompt block at the start of every subsequent loop
 *     run. The tool returns `{ id }` so the agent can later refer back to
 *     the entry by its stable id.
 *   - `note_close` flips an entry's status to `'closed'` (by id, with an
 *     optional one-line reason). Closed notes stay in storage as history
 *     for audit / UI display but are filtered out of the prompt injection
 *     path so they no longer steer the agent.
 *
 * The mechanism behind both:
 *
 *   1. Each note is appended to a per-chat floor-state namespace
 *      (`luker_orch_loop_notes`) tagged at a target floor — defaults to
 *      the chat tail (`max(0, chat.length - 1)`) so the note follows the
 *      conversation when branches / deletions reshape history. Tests can
 *      override the target floor through `context.__targetFloorForNote`.
 *   2. `loadOpenNotes(context)` reads every surviving open note via the
 *      adapter's `listAcrossFloors()` helper and filters out closed
 *      entries. Loop-runtime calls this once at run start and stashes the
 *      result on the context so `buildInitialMessages` can render the
 *      `## Open Notes` block. `loadAllNotes` is a back-compat alias for
 *      `loadOpenNotes` during the staged refactor; both currently surface
 *      open-only entries.
 *   3. No LRU. Each note is hard-capped at 16 KiB UTF-8 so a single entry
 *      can't blow up the prompt, but the count is unbounded — the agent
 *      is expected to close notes when their thread resolves rather than
 *      relying on silent eviction. Closed notes are excluded from the
 *      prompt injection path, so unbounded growth of historical
 *      (closed) entries doesn't pressure the active prompt.
 *
 * Validation:
 *   - `note_open` text empty / whitespace-only → ToolError(NOTE_EMPTY)
 *   - `note_open` text byte length > 16384 → ToolError(NOTE_TOO_LONG)
 *   - `note_open` adapter write rejection → ToolError mapped from the
 *     state-error reason (CONFLICT → NOTE_WRITE_CONFLICT, INSTANCE_DESTROYED
 *     → NOTE_FS_DESTROYED, etc. — see `mapNoteReasonToToolError`)
 *   - `note_close` id missing / empty → ToolError(NOTE_ID_EMPTY)
 *   - `note_close` against unknown / already-closed id is NOT a throw —
 *     the adapter returns `{ ok: false, error: 'not_found' | 'already_closed' }`
 *     and the tool passes that through so the agent can branch on it
 *     without an exception interrupting the loop.
 *   - `note_close` adapter write rejection → ToolError mapped the same way
 *     as note_open. The reducer-no-op path is distinguished by inspecting
 *     `result.error` (preserved as-is) vs `result.reason` (the failure
 *     envelope to translate).
 *
 * Adapter contract (`context.__floorStateForNotes` in tests, production
 * wrapper in loop-runtime's `attachNotesFloorState`):
 *
 *   {
 *     appendForFloor(floor: number, text: string):
 *         Promise<{ok:true, id:string} | {ok:false, reason:string, hint:string}>
 *       // success returns the new id; write rejections surface state-error
 *       // reason/hint envelopes (see ../loop-runtime.js: makeNotesAdapter
 *       // and ../../state-errors.js: STATE_ERROR_REASONS).
 *     listAcrossFloors(): Promise<Array<{id, text, status, closure_reason?}>>
 *       // chronological; legacy entries without `status` are treated as 'open'
 *     updateStatusById(id, status, reason?):
 *         Promise<{ok:true}
 *               | {ok:false, error:string}
 *               | {ok:false, reason:string, hint:string}>
 *       // ok:false+error covers reducer no-ops (not_found / already_<status>);
 *       // ok:false+reason covers patch rejection.
 *     updateTextById(id, text):
 *         Promise<{ok:true}
 *               | {ok:false, error:string}
 *               | {ok:false, reason:string, hint:string}>
 *     deleteByIds(ids: string[]):
 *         Promise<{ removed: string[], missing: string[] }
 *               | {ok:false, reason:string, hint:string}>
 *       // hard-delete from storage (used by UI / curator agent, not the LLM tools).
 *       // `removed` lists the ids that were actually present and dropped.
 *   }
 *
 * Stable IDs are visible to the agent in the `## Open Notes` block, and
 * `note_close` takes that id directly. There is no positional / index
 * resolution and no per-run snapshot: two agents working concurrently
 * can close different notes by id without their references shifting
 * under each other.
 *
 * Production's wrapper sits over a real `floor-state` instance and
 * realizes append / list / status-update / text-update / delete through
 * `fs.update(reducer, { floor })` + `fs.get()`; the test fixture is a
 * plain in-memory array so we don't have to boot floor-state's
 * chat-state stack inside Jest.
 */

import { ToolError } from '../loop-runtime.js';

const MAX_NOTE_BYTES = 16 * 1024;

/**
 * Compute the UTF-8 byte length of a string. Browser-safe via TextEncoder
 * (Node also exposes it globally since v11). Avoids `Buffer.byteLength`
 * so this module stays portable to both runtimes — `loop-tools.js` is
 * imported by browser-side `main.js`.
 */
function utf8ByteLength(text) {
    return new TextEncoder().encode(String(text || '')).byteLength;
}

function pickFloorStateForNotes(context) {
    if (context && context.__floorStateForNotes && typeof context.__floorStateForNotes === 'object') {
        return context.__floorStateForNotes;
    }
    return null;
}

function pickTargetFloor(context) {
    if (Number.isFinite(Number(context?.__targetFloorForNote))) {
        return Math.max(0, Math.floor(Number(context.__targetFloorForNote)));
    }
    const chatLen = Array.isArray(context?.chat) ? context.chat.length : 0;
    return Math.max(0, chatLen - 1);
}

/**
 * Translate the notes adapter's write-rejection envelope into a structured
 * ToolError the agent can read on the next round. Mirrors the closed enum
 * in `state-errors.js` (`STATE_ERROR_REASONS`); any unknown reason maps to
 * a generic `NOTE_WRITE_FAILED` so a future floor-state failure mode can't
 * silently drop the agent into a fake-success path.
 *
 * Reducer no-op outcomes (`{ok:false, error:'not_found'|'already_X'}`)
 * never reach this helper — those are domain results the tool layer passes
 * through verbatim so the agent can branch on them without an exception.
 *
 * @param {'note_open'|'note_close'|'note_edit'|'note_delete'} op
 * @param {{reason?: string, hint?: string}} result
 * @returns {ToolError}
 */
function mapNoteReasonToToolError(op, result) {
    const reason = result?.reason || 'UNKNOWN';
    const hint = String(result?.hint || '');
    const mapping = {
        VALIDATION_ARGS: ['NOTE_WRITE_INVALID_ARGS',
            hint ? `Note arguments were rejected by floor-state: ${hint}` : 'Note arguments were rejected by floor-state.'],
        VALIDATION_TARGET: ['NOTE_NO_ACTIVE_CHAT',
            'The active chat has not been persisted yet. Persist a turn first or drop this note for this round.'],
        VALIDATION_COMMIT: ['NOTE_FLOOR_INVALID',
            hint ? `Floor for this note is invalid: ${hint}` : 'Floor for this note is invalid.'],
        INSTANCE_DESTROYED: ['NOTE_FS_DESTROYED',
            'Notes storage was destroyed for this session. Drop this note — the user must reload the page to recover.'],
        CONFLICT: ['NOTE_WRITE_CONFLICT',
            'Another writer raced this note. Retry once; if it still fails, drop the note for this round.'],
        HTTP_ERROR: ['NOTE_WRITE_HTTP_ERROR',
            hint ? `Notes store returned an HTTP error: ${hint}` : 'Notes store returned an HTTP error. Retry once.'],
        TRANSPORT_ERROR: ['NOTE_WRITE_TRANSPORT_ERROR',
            hint ? `Network error saving the note: ${hint}` : 'Network error saving the note. Retry once.'],
        REPLAY_BROKEN: ['NOTE_LOG_BROKEN',
            'Notes commit log is broken (replay failed). Stop trying to write notes this run.'],
        LOG_WRITE_FAILED: ['NOTE_LOG_WRITE_FAILED',
            hint ? `Notes log write failed: ${hint}` : 'Notes log write failed. Retry once; if it still fails, drop the note for this round.'],
    };
    const [code, mappedHint] = mapping[reason] || ['NOTE_WRITE_FAILED',
        'Notes write failed. Drop this note for this round.'];
    return new ToolError(`${op}: notes write rejected (${reason}).`, code, mappedHint);
}

/**
 * Open (= append) a persistent note tagged at the chat tail (or
 * `context.__targetFloorForNote` if provided). New notes are persisted
 * with `status: 'open'` by the adapter. Returns the new note's stable id
 * so the agent can refer back to it later for `note_close`.
 *
 * @param {{ text: string }} args
 * @param {object} context
 * @returns {Promise<{ id: string }>}
 */
export async function execNoteOpen(args, context) {
    const trimmed = String(args?.text ?? '').trim();
    if (!trimmed) {
        throw new ToolError(
            'note_open: text must be non-empty.',
            'NOTE_EMPTY',
            'Provide a non-empty note. Whitespace-only is rejected so the agent doesn\'t accumulate blank entries.',
        );
    }
    if (utf8ByteLength(trimmed) > MAX_NOTE_BYTES) {
        throw new ToolError(
            `note_open: text too long (max ${MAX_NOTE_BYTES} UTF-8 bytes).`,
            'NOTE_TOO_LONG',
            `Trim the note to <= ${MAX_NOTE_BYTES} bytes. Long-form context belongs in memory-graph or lorebook entries; notes are short reminders.`,
        );
    }
    const fs = pickFloorStateForNotes(context);
    if (!fs || typeof fs.appendForFloor !== 'function') {
        throw new ToolError(
            'note_open: notes floor-state not initialized.',
            'NOTE_FS_UNAVAILABLE',
            'The loop runtime did not mount the notes floor-state for this run. This is usually a setup issue (missing context.createFloorState) — retry once.',
        );
    }

    const floor = pickTargetFloor(context);
    const result = await fs.appendForFloor(floor, trimmed);
    if (!result || result.ok === false) {
        throw mapNoteReasonToToolError('note_open', result || {});
    }
    return { id: String(result.id) };
}

/**
 * Close an open note by stable id, with an optional one-line reason
 * (e.g. "used by hero at floor 53"). The adapter returns:
 *   - `{ ok: true }` on a successful flip — passed through.
 *   - `{ ok: false, error }` for reducer no-ops (`not_found` /
 *     `already_closed`) — passed through verbatim so the agent can branch
 *     on a real result without an exception interrupting the loop.
 *   - `{ ok: false, reason, hint }` when the underlying floor-state patch
 *     was rejected — translated to a structured `ToolError` so the agent
 *     sees the failure mode (and the runtime turns it into a `role: tool`
 *     reply for the next round, not a runtime crash).
 *
 * Only structural problems (missing id arg, adapter not mounted) and
 * adapter write rejections throw.
 *
 * @param {{ id: string, reason?: string }} args
 * @param {object} context
 * @returns {Promise<{ok:true} | {ok:false, error:string}>}
 */
export async function execNoteClose(args, context) {
    const id = String(args?.id ?? '').trim();
    if (!id) {
        throw new ToolError(
            'note_close: id must be non-empty.',
            'NOTE_ID_EMPTY',
            'Pass the id string visible in the Open Notes block.',
        );
    }
    const reason = typeof args?.reason === 'string' ? args.reason : '';
    const fs = pickFloorStateForNotes(context);
    if (!fs || typeof fs.updateStatusById !== 'function') {
        throw new ToolError(
            'note_close: notes floor-state not initialized.',
            'NOTE_FS_UNAVAILABLE',
            'The loop runtime did not mount the notes floor-state for this run. This is usually a setup issue (missing context.createFloorState) — retry once.',
        );
    }
    const result = await fs.updateStatusById(id, 'closed', reason);
    // Only the write-rejection branch (has `reason`) becomes a ToolError;
    // reducer no-ops (have `error`) are domain outcomes the agent should
    // branch on directly. Keeping these distinct preserves the existing
    // contract for not_found / already_closed without masking real
    // floor-state failures behind the same shape.
    if (result && result.ok === false && result.reason) {
        throw mapNoteReasonToToolError('note_close', result);
    }
    return result;
}

/**
 * Read every open (non-closed) persisted note for the current chat in
 * chronological order. Closed entries are filtered out so they don't
 * pollute the prompt. Legacy entries with no `status` field are treated
 * as `'open'` for back-compat with chats predating the status refactor.
 *
 * Returns `[]` when the floor-state adapter is missing — `loop-runtime`
 * checks the result before injecting an Open Notes block, so an empty
 * list simply means no historical context to bring forward.
 *
 * @param {object} context
 * @returns {Promise<Array<{id: string, text: string}>>}
 */
export async function loadOpenNotes(context) {
    const fs = pickFloorStateForNotes(context);
    if (!fs || typeof fs.listAcrossFloors !== 'function') return [];
    const all = await fs.listAcrossFloors();
    if (!Array.isArray(all)) return [];
    return all
        .filter(e => e && typeof e === 'object' && (e.status ?? 'open') === 'open')
        .map(e => ({ id: String(e.id || ''), text: String(e.text || '') }));
}

/**
 * Back-compat alias for `loadOpenNotes`. Kept during the staged refactor
 * so existing imports (`loop-runtime`, tests) keep working; this alias
 * surfaces only open notes — the same filtered view the prompt injects.
 *
 * @deprecated Use `loadOpenNotes` directly; this alias will be removed
 * once all callers are migrated.
 */
export const loadAllNotes = loadOpenNotes;

export const NOTES_NAMESPACE = 'luker_orch_loop_notes';
export const NOTE_LIMITS = Object.freeze({
    MAX_NOTE_BYTES,
});
