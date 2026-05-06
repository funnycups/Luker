/**
 * loop-tools/note.js — note.add tool for loop mode (Plan Task 11).
 *
 * `note.add` lets the agent persist a free-form text note that survives
 * across loop runs and is re-injected into the agent's system prompt at
 * the start of each subsequent run. The mechanism is:
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
 *      "## Previous Notes" header.
 *   3. LRU pruning at 50 notes total — the oldest entries are dropped via
 *      `pruneOldest(n)` whenever an append takes the list past the cap.
 *      The cap exists to bound prompt size; loud failure (rejecting the
 *      append) would surprise the agent more than a silent drop.
 *
 * Validation:
 *   - text empty / whitespace-only → ToolError(NOTE_EMPTY)
 *   - text byte length > 1024 → ToolError(NOTE_TOO_LONG)
 *
 * Adapter contract (`context.__floorStateForNotes` in tests, production
 * wrapper in loop-runtime's `attachNotesFloorState`):
 *
 *   {
 *     appendForFloor(floor: number, text: string): Promise<void>
 *     listAcrossFloors(): Promise<string[]>     // chronological order
 *     pruneOldest(n: number): Promise<void>     // optional; drop n oldest
 *   }
 *
 * Production's wrapper sits over a real `floor-state` instance and
 * realizes append / list / prune through `fs.update(reducer, { floor })`
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

export const NOTES_NAMESPACE = 'luker_orch_loop_notes';
export const NOTE_LIMITS = Object.freeze({
    MAX_NOTE_BYTES,
    MAX_NOTES_TOTAL,
});
