/**
 * loop-tools/note.js — note tools for loop mode (Plan Task 11).
 *
 * Two tools:
 *
 *   - `note_add` appends a free-form note (per-chat, cross-run). Notes
 *     re-inject at the start of every subsequent loop run as a numbered
 *     `## Previous Notes` block.
 *   - `note_delete` removes notes by their 1-based positions in that
 *     same numbered block, so the agent can prune entries whose role is
 *     exhausted (foreshadowing fired, setting superseded, etc.).
 *
 * The mechanism behind both:
 *
 *   1. Each note is appended to a per-chat floor-state namespace
 *      (`luker_orch_loop_notes`) tagged at a target floor — defaults to
 *      the chat tail (`max(0, chat.length - 1)`) so the note follows the
 *      conversation when branches / deletions reshape history. Tests can
 *      override the target floor through `context.__targetFloorForNote`.
 *   2. `loadAllNotes(context)` reads every surviving note via the
 *      adapter's `listAcrossFloors()` helper. Loop-runtime calls this
 *      once at run start and stashes the result on `context.__loopNotes`,
 *      which `buildInitialMessages` joins into the system prompt under a
 *      "## Previous Notes" header — same array, same order, same 1-based
 *      numbering the agent sees.
 *   3. LRU pruning at 50 notes total — the oldest entries are dropped via
 *      `pruneOldest(n)` whenever an append takes the list past the cap.
 *      The cap exists to bound prompt size; loud failure (rejecting the
 *      append) would surprise the agent more than a silent drop.
 *
 * Validation:
 *   - `note_add` text empty / whitespace-only → ToolError(NOTE_EMPTY)
 *   - `note_add` text byte length > 1024 → ToolError(NOTE_TOO_LONG)
 *   - `note_delete` indexes empty / non-array → ToolError(NOTE_DELETE_EMPTY)
 *   - `note_delete` indexes contain non-integer or < 1 → ToolError(NOTE_INDEX_INVALID)
 *   - `note_delete` indexes out of range against current count → ToolError(NOTE_INDEX_OUT_OF_RANGE)
 *
 * Adapter contract (`context.__floorStateForNotes` in tests, production
 * wrapper in loop-runtime's `attachNotesFloorState`):
 *
 *   {
 *     appendForFloor(floor: number, text: string): Promise<string>  // returns new id
 *     listAcrossFloors(): Promise<Array<{id, text}>>                // chronological
 *     pruneOldest(n: number): Promise<void>                         // optional; drop n oldest
 *     deleteByIds(ids: string[]): Promise<{ removed, missing }>
 *   }
 *
 * Stable IDs let `note_delete` work safely under multi-agent concurrency.
 * The LLM-facing schema still takes `indexes: int[]` (1-based positions
 * in the "## Previous Notes" block); this module resolves those positions
 * through `context.__noteIdSnapshot` — the id sequence the agent's prompt
 * was built with — into the underlying ids. If another agent has deleted
 * a target id since the snapshot was taken, the adapter reports it via
 * `missing`; the tool surfaces this as `already_gone` so the calling
 * agent knows the intent landed (or didn't) without retrying blindly.
 *
 * Production's wrapper sits over a real `floor-state` instance and
 * realizes append / list / prune / delete through `fs.update(reducer, { floor })`
 * + `fs.get()`; the test fixture is a plain in-memory array so we don't
 * have to boot floor-state's chat-state stack inside Jest.
 */

import { ToolError } from '../loop-runtime.js';

const MAX_NOTE_BYTES = 1024;
const MAX_NOTES_TOTAL = 50;

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
 * Append a persistent note tagged at the chat tail (or
 * `context.__targetFloorForNote` if provided). LRU caps at 50 notes
 * total; older entries are pruned silently. On success, the new note's
 * id is pushed onto `context.__noteIdSnapshot` so subsequent
 * `note_delete` calls in the same agent see their own writes.
 *
 * @param {{ text: string }} args
 * @param {object} context
 * @returns {Promise<{ ok: true }>}
 */
export async function execNoteAdd(args, context) {
    const trimmed = String(args?.text ?? '').trim();
    if (!trimmed) {
        throw new ToolError(
            'note_add: text must be non-empty.',
            'NOTE_EMPTY',
            'Provide a non-empty note. Whitespace-only is rejected so the agent doesn\'t accumulate blank entries.',
        );
    }
    if (utf8ByteLength(trimmed) > MAX_NOTE_BYTES) {
        throw new ToolError(
            `note_add: text too long (max ${MAX_NOTE_BYTES} UTF-8 bytes).`,
            'NOTE_TOO_LONG',
            `Trim the note to <= ${MAX_NOTE_BYTES} bytes. Long-form context belongs in memory-graph or lorebook entries; notes are short reminders.`,
        );
    }
    const fs = pickFloorStateForNotes(context);
    if (!fs || typeof fs.appendForFloor !== 'function') {
        throw new ToolError(
            'note_add: notes floor-state not initialized.',
            'NOTE_FS_UNAVAILABLE',
            'The loop runtime did not mount the notes floor-state for this run. This is usually a setup issue (missing context.createFloorState) — retry once.',
        );
    }

    const floor = pickTargetFloor(context);
    const newId = await fs.appendForFloor(floor, trimmed);

    if (context && Array.isArray(context.__noteIdSnapshot) && typeof newId === 'string' && newId) {
        context.__noteIdSnapshot.push(newId);
    }

    if (typeof fs.listAcrossFloors === 'function' && typeof fs.pruneOldest === 'function') {
        const all = await fs.listAcrossFloors();
        if (Array.isArray(all) && all.length > MAX_NOTES_TOTAL) {
            const drop = all.length - MAX_NOTES_TOTAL;
            await fs.pruneOldest(drop);
            // Trim the snapshot's head to match — pruneOldest drops the
            // oldest entries first, so the first `drop` ids in the snapshot
            // are the ones that just got reaped.
            if (context && Array.isArray(context.__noteIdSnapshot)) {
                context.__noteIdSnapshot.splice(0, drop);
            }
        }
    }

    return { ok: true };
}

/**
 * Read every persisted note for the current chat in chronological order.
 * Returns `[]` when the floor-state adapter is missing — `loop-runtime`
 * checks the result before injecting a "Previous Notes" block, so an
 * empty list simply means no historical context to bring forward.
 *
 * @param {object} context
 * @returns {Promise<Array<{id: string, text: string}>>}
 */
export async function loadAllNotes(context) {
    const fs = pickFloorStateForNotes(context);
    if (!fs || typeof fs.listAcrossFloors !== 'function') return [];
    const all = await fs.listAcrossFloors();
    if (!Array.isArray(all)) return [];
    return all
        .map(entry => {
            if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
                return { id: String(entry.id || ''), text: entry.text };
            }
            // Legacy adapter that still returns bare strings — synthesize an
            // empty id so callers can read .text safely. Shouldn't happen
            // post-migration but keeps the contract defensive.
            return { id: '', text: String(entry ?? '') };
        });
}

/**
 * Delete persisted notes by their 1-based positions in the system-prompt
 * "## Previous Notes" block. Positions resolve through
 * `context.__noteIdSnapshot` — the id sequence the agent saw at prompt
 * build time — into stable ids the adapter deletes by. This makes the
 * tool safe under concurrent multi-agent operation: two agents that
 * observed the same snapshot can independently delete different
 * positions without their indexes shifting under each other.
 *
 * Validation is strict so the agent gets actionable feedback:
 *   - empty / non-array → NOTE_DELETE_EMPTY
 *   - any element non-integer or < 1 → NOTE_INDEX_INVALID
 *   - any element > snapshot length → NOTE_INDEX_OUT_OF_RANGE
 *
 * Returns `{ ok: true, removed, remaining, already_gone? }`. `already_gone`
 * is included only when a target id was deleted by another agent since
 * this agent's snapshot was taken — informational, the agent's intent
 * still landed for whichever ids remained.
 *
 * @param {{ indexes: number[] }} args
 * @param {object} context
 * @returns {Promise<{ ok: true, removed: number, remaining: number, already_gone?: number[] }>}
 */
export async function execNoteDelete(args, context) {
    const raw = args?.indexes;
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new ToolError(
            'note_delete: indexes must be a non-empty array.',
            'NOTE_DELETE_EMPTY',
            'Pass indexes as an array of 1-based positions matching the "## Previous Notes" block, e.g. [1, 3].',
        );
    }
    const cleaned = [];
    const invalid = [];
    for (const value of raw) {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
            invalid.push(value);
            continue;
        }
        cleaned.push(n);
    }
    if (invalid.length > 0) {
        throw new ToolError(
            `note_delete: indexes must be positive integers (got: ${JSON.stringify(invalid)}).`,
            'NOTE_INDEX_INVALID',
            'Each entry must be a 1-based integer matching the system-prompt note numbering. Negative numbers, zero, and fractional values are rejected.',
        );
    }

    const fs = pickFloorStateForNotes(context);
    if (!fs || typeof fs.deleteByIds !== 'function') {
        throw new ToolError(
            'note_delete: notes floor-state not initialized.',
            'NOTE_FS_UNAVAILABLE',
            'The loop runtime did not mount the notes floor-state for this run. This is usually a setup issue (missing context.createFloorState) — retry once.',
        );
    }

    // Resolve indexes → ids via the agent's snapshot. If no snapshot was
    // staged (test fixture, legacy caller), fall back to reading the
    // current adapter state — same semantics as the old index-based path
    // for the single-agent case.
    let snapshot = Array.isArray(context?.__noteIdSnapshot) ? context.__noteIdSnapshot : null;
    if (!snapshot) {
        const live = typeof fs.listAcrossFloors === 'function' ? await fs.listAcrossFloors() : [];
        snapshot = (Array.isArray(live) ? live : []).map(e => (e && typeof e === 'object') ? String(e.id || '') : '');
    }
    const snapshotLen = snapshot.length;
    if (snapshotLen === 0) {
        throw new ToolError(
            'note_delete: no notes to delete.',
            'NOTE_INDEX_OUT_OF_RANGE',
            'The "## Previous Notes" block is empty for this chat. Add notes via note_add first; nothing to prune yet.',
        );
    }
    const outOfRange = cleaned.filter(n => n > snapshotLen);
    if (outOfRange.length > 0) {
        throw new ToolError(
            `note_delete: indexes out of range (got ${JSON.stringify(outOfRange)}, only ${snapshotLen} note(s) exist).`,
            'NOTE_INDEX_OUT_OF_RANGE',
            `Use 1-based indexes between 1 and ${snapshotLen}. Re-check the system-prompt "## Previous Notes" block for current numbering.`,
        );
    }

    const uniqueIndexes = Array.from(new Set(cleaned));
    const idsByIndex = new Map();
    for (const oneBased of uniqueIndexes) {
        const id = snapshot[oneBased - 1];
        if (id) idsByIndex.set(oneBased, id);
    }
    const ids = Array.from(idsByIndex.values());

    const result = await fs.deleteByIds(ids);
    const removed = Number(result?.removed || 0);
    const missingIds = new Set(Array.isArray(result?.missing) ? result.missing : []);

    // Drop deleted ids from the agent's snapshot so subsequent positional
    // calls in the same run reflect the new state. Skip ones that came
    // back as `missing` (they're already absent from upstream state).
    if (context && Array.isArray(context.__noteIdSnapshot)) {
        for (const id of ids) {
            const at = context.__noteIdSnapshot.indexOf(id);
            if (at >= 0) context.__noteIdSnapshot.splice(at, 1);
        }
    }

    const alreadyGone = [];
    for (const [oneBased, id] of idsByIndex) {
        if (missingIds.has(id)) alreadyGone.push(oneBased);
    }

    const response = {
        ok: true,
        removed,
        remaining: Math.max(0, snapshotLen - removed),
    };
    if (alreadyGone.length > 0) {
        alreadyGone.sort((a, b) => a - b);
        response.already_gone = alreadyGone;
    }
    return response;
}

export const NOTES_NAMESPACE = 'luker_orch_loop_notes';
export const NOTE_LIMITS = Object.freeze({
    MAX_NOTE_BYTES,
    MAX_NOTES_TOTAL,
});
