/**
 * loop-tools/note.js — note tools for loop mode (Plan Task 11).
 *
 * Two tools:
 *
 *   - `note.add` appends a free-form note (per-chat, cross-run). Notes
 *     re-inject at the start of every subsequent loop run as a numbered
 *     `## Previous Notes` block.
 *   - `note.delete` removes notes by their 1-based positions in that
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
 *   - `note.add` text empty / whitespace-only → ToolError(NOTE_EMPTY)
 *   - `note.add` text byte length > 1024 → ToolError(NOTE_TOO_LONG)
 *   - `note.delete` indexes empty / non-array → ToolError(NOTE_DELETE_EMPTY)
 *   - `note.delete` indexes contain non-integer or < 1 → ToolError(NOTE_INDEX_INVALID)
 *   - `note.delete` indexes out of range against current count → ToolError(NOTE_INDEX_OUT_OF_RANGE)
 *
 * Adapter contract (`context.__floorStateForNotes` in tests, production
 * wrapper in loop-runtime's `attachNotesFloorState`):
 *
 *   {
 *     appendForFloor(floor: number, text: string): Promise<void>
 *     listAcrossFloors(): Promise<string[]>     // chronological order
 *     pruneOldest(n: number): Promise<void>     // optional; drop n oldest
 *     deleteByIndex(indexes: number[]): Promise<{ removed: number }>
 *                                                 // 1-based positions
 *   }
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
 * total; older entries are pruned silently.
 *
 * @param {{ text: string }} args
 * @param {object} context
 * @returns {Promise<{ ok: true }>}
 */
export async function execNoteAdd(args, context) {
    const trimmed = String(args?.text ?? '').trim();
    if (!trimmed) {
        throw new ToolError(
            'note.add: text must be non-empty.',
            'NOTE_EMPTY',
            'Provide a non-empty note. Whitespace-only is rejected so the agent doesn\'t accumulate blank entries.',
        );
    }
    if (utf8ByteLength(trimmed) > MAX_NOTE_BYTES) {
        throw new ToolError(
            `note.add: text too long (max ${MAX_NOTE_BYTES} UTF-8 bytes).`,
            'NOTE_TOO_LONG',
            `Trim the note to <= ${MAX_NOTE_BYTES} bytes. Long-form context belongs in memory-graph or lorebook entries; notes are short reminders.`,
        );
    }
    const fs = pickFloorStateForNotes(context);
    if (!fs || typeof fs.appendForFloor !== 'function') {
        throw new ToolError(
            'note.add: notes floor-state not initialized.',
            'NOTE_FS_UNAVAILABLE',
            'The loop runtime did not mount the notes floor-state for this run. This is usually a setup issue (missing context.createFloorState) — retry once.',
        );
    }

    const floor = pickTargetFloor(context);
    await fs.appendForFloor(floor, trimmed);

    if (typeof fs.listAcrossFloors === 'function' && typeof fs.pruneOldest === 'function') {
        const all = await fs.listAcrossFloors();
        if (Array.isArray(all) && all.length > MAX_NOTES_TOTAL) {
            await fs.pruneOldest(all.length - MAX_NOTES_TOTAL);
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
 * @returns {Promise<string[]>}
 */
export async function loadAllNotes(context) {
    const fs = pickFloorStateForNotes(context);
    if (!fs || typeof fs.listAcrossFloors !== 'function') return [];
    const all = await fs.listAcrossFloors();
    return Array.isArray(all) ? all.map(s => String(s ?? '')) : [];
}

/**
 * Delete persisted notes by their 1-based positions in the system-prompt
 * "## Previous Notes" block. The agent calls this to prune notes whose
 * role is exhausted (foreshadowing fired, character beat already
 * happened, setting superseded by later events) so the block doesn't
 * degenerate into noise.
 *
 * Validation is strict so the agent gets actionable feedback:
 *   - empty / non-array → NOTE_DELETE_EMPTY
 *   - any element non-integer or < 1 → NOTE_INDEX_INVALID
 *   - any element > current count → NOTE_INDEX_OUT_OF_RANGE
 *
 * On success returns `{ ok: true, removed, remaining }` where `removed`
 * is the count actually dropped and `remaining` is the post-deletion
 * note count, so the agent can confirm the pruning landed without an
 * extra round-trip to re-list.
 *
 * @param {{ indexes: number[] }} args
 * @param {object} context
 * @returns {Promise<{ ok: true, removed: number, remaining: number }>}
 */
export async function execNoteDelete(args, context) {
    const raw = args?.indexes;
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new ToolError(
            'note.delete: indexes must be a non-empty array.',
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
            `note.delete: indexes must be positive integers (got: ${JSON.stringify(invalid)}).`,
            'NOTE_INDEX_INVALID',
            'Each entry must be a 1-based integer matching the system-prompt note numbering. Negative numbers, zero, and fractional values are rejected.',
        );
    }

    const fs = pickFloorStateForNotes(context);
    if (!fs || typeof fs.listAcrossFloors !== 'function' || typeof fs.deleteByIndex !== 'function') {
        throw new ToolError(
            'note.delete: notes floor-state not initialized.',
            'NOTE_FS_UNAVAILABLE',
            'The loop runtime did not mount the notes floor-state for this run. This is usually a setup issue (missing context.createFloorState) — retry once.',
        );
    }

    const before = await fs.listAcrossFloors();
    const beforeCount = Array.isArray(before) ? before.length : 0;
    if (beforeCount === 0) {
        throw new ToolError(
            'note.delete: no notes to delete.',
            'NOTE_INDEX_OUT_OF_RANGE',
            'The "## Previous Notes" block is empty for this chat. Add notes via note.add first; nothing to prune yet.',
        );
    }
    const outOfRange = cleaned.filter(n => n > beforeCount);
    if (outOfRange.length > 0) {
        throw new ToolError(
            `note.delete: indexes out of range (got ${JSON.stringify(outOfRange)}, only ${beforeCount} note(s) exist).`,
            'NOTE_INDEX_OUT_OF_RANGE',
            `Use 1-based indexes between 1 and ${beforeCount}. Re-check the system-prompt "## Previous Notes" block for current numbering.`,
        );
    }

    const result = await fs.deleteByIndex(cleaned);
    const removed = Number(result?.removed || 0);
    return {
        ok: true,
        removed,
        remaining: Math.max(0, beforeCount - removed),
    };
}

export const NOTES_NAMESPACE = 'luker_orch_loop_notes';
export const NOTE_LIMITS = Object.freeze({
    MAX_NOTE_BYTES,
    MAX_NOTES_TOTAL,
});
