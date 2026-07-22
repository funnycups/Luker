/**
 * open-notes-injection.js — single source of truth for surfacing the
 * `## Open Notes` block into every orchestration agent's prompt stack.
 *
 * All four orchestration modes (loop / director / spec / agenda) share
 * one persistent notes store per chat (`luker_orch_loop_notes`
 * floor-state namespace, mounted by `loop-runtime.attachNotesFloorState`
 * onto `context.__floorStateForNotes`). The visibility rule is uniform:
 *
 *   Every agent — regardless of mode, regardless of whether the agent's
 *   preset enables the `note_open` / `note_close` tools — sees the same
 *   `## Open Notes` block whenever there are any open notes for the
 *   current chat.
 *
 * Visibility and mutation are DECOUPLED. Read-access is universal;
 * write-access rides on the per-preset `tools.note` flag through the
 * loop-tool cascade. An agent without note tools can still reason about
 * the plot threads its author-self has recorded — it just can't open
 * new ones or close existing ones itself.
 *
 * The renderer format (`## Open Notes ...\n- [id] text` per entry)
 * matches the historical loop-runtime / director shape verbatim so the
 * same close-by-id contract applies wherever notes appear.
 */

/**
 * Read the open subset of persisted notes off a context carrying a
 * mounted notes floor-state adapter. Returns `[]` for every unhappy
 * path — missing adapter, adapter without `listAcrossFloors`, thrown
 * listAcrossFloors, non-array return — so callers can compose without
 * null-checks. Legacy entries without a `status` field are treated as
 * open (matches the historical loop-runtime / director filter).
 *
 * @param {object|null|undefined} contextForNotes
 * @returns {Promise<Array<{id: string, text: string}>>}
 */
export async function readOpenNotes(contextForNotes) {
    const fs = contextForNotes && contextForNotes.__floorStateForNotes;
    if (!fs || typeof fs.listAcrossFloors !== 'function') return [];
    let all;
    try {
        all = await fs.listAcrossFloors();
    } catch (_) {
        return [];
    }
    if (!Array.isArray(all)) return [];
    return all
        .filter(e => e && typeof e === 'object' && (e.status ?? 'open') === 'open')
        .map(e => ({ id: String(e.id || ''), text: String(e.text || '') }));
}

/**
 * Render the `## Open Notes` block from an already-loaded list. Returns
 * an empty string when the list is empty so callers can compose it into
 * a runtime-state body without conditional guards.
 *
 * @param {Array<{id: string, text: string}>|null|undefined} openNotes
 * @returns {string}
 */
export function renderOpenNotesBlock(openNotes) {
    const open = Array.isArray(openNotes) ? openNotes : [];
    if (open.length === 0) return '';
    const lines = ['## Open Notes (your plot-author threads — close with note_close when deployed)'];
    for (const n of open) {
        const id = String(n?.id ?? '').trim();
        const text = String(n?.text ?? '');
        if (!id && !text) continue;
        lines.push(`- [${id}] ${text}`);
    }
    return lines.length === 1 ? '' : lines.join('\n');
}

/**
 * One-shot read + render. Returns `''` when there is no adapter or no
 * open notes; otherwise returns the block string ready to be composed
 * into a `<runtime_state>` user message or appended to a system prompt.
 *
 * @param {object|null|undefined} contextForNotes
 * @returns {Promise<string>}
 */
export async function loadOpenNotesBlock(contextForNotes) {
    const openNotes = await readOpenNotes(contextForNotes);
    return renderOpenNotesBlock(openNotes);
}

/**
 * Compose the standard "runtime state" user message that carries the
 * Open Notes block for modes that ship volatile per-dispatch context
 * as a trailing user message (spec / agenda / director sub-agents).
 * Returns `null` when there is no block to inject so callers can
 * spread the result into a messages array without conditional guards
 * (`messages.push(...[msg].filter(Boolean))`).
 *
 * Callers that need to compose additional runtime-state sections
 * (e.g. main-agent digest, current-draft snapshot in director mode)
 * should call `loadOpenNotesBlock` directly and assemble their own
 * `<runtime_state>` envelope — this helper is the single-section
 * convenience for the common case.
 *
 * @param {object|null|undefined} contextForNotes
 * @returns {Promise<{role: 'user', content: string} | null>}
 */
export async function buildOpenNotesRuntimeStateMessage(contextForNotes) {
    const block = await loadOpenNotesBlock(contextForNotes);
    if (!block) return null;
    return {
        role: 'user',
        content: `<runtime_state>\n${block}\n</runtime_state>`,
    };
}
