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
 *   - `note_close` id missing / empty → ToolError(NOTE_ID_EMPTY)
 *   - `note_close` against unknown / already-closed id is NOT a throw —
 *     the adapter returns `{ ok: false, error: 'not_found' | 'already_closed' }`
 *     and the tool passes that through so the agent can branch on it
 *     without an exception interrupting the loop.
 *
 * Adapter contract (`context.__floorStateForNotes` in tests, production
 * wrapper in loop-runtime's `attachNotesFloorState`):
 *
 *   {
 *     appendForFloor(floor: number, text: string): Promise<string>
 *       // returns new id; entry persisted with status: 'open'
 *     listAcrossFloors(): Promise<Array<{id, text, status, closure_reason?}>>
 *       // chronological; legacy entries without `status` are treated as 'open'
 *     updateStatusById(id, status, reason?): Promise<{ok:true} | {ok:false, error:string}>
 *       // flip a single entry's status; reports `already_<status>` on no-op
 *     updateTextById(id, text): Promise<{ok:true} | {ok:false, error:string}>
 *       // mutate an existing entry's text (used by UI / curator agent)
 *     deleteByIds(ids: string[]): Promise<{ removed: string[], missing: string[] }>
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
    const newId = await fs.appendForFloor(floor, trimmed);
    return { id: String(newId) };
}

/**
 * Close an open note by stable id, with an optional one-line reason
 * (e.g. "used by hero at floor 53"). The adapter returns
 * `{ ok: true }` on a successful flip, or `{ ok: false, error }` for
 * `not_found` / `already_closed` — those are real outcomes the agent
 * should branch on, not exceptional failures, so the tool passes the
 * adapter result through without ToolError wrapping. Only structural
 * problems (missing id arg, adapter not mounted) throw.
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
    return await fs.updateStatusById(id, 'closed', reason);
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
