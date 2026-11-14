// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Token counter for what memory-graph injects into the prompt.
// memory-graph only keeps the latest injection, so a small recorder (started
// from index.js, runs even while the lens is closed) appends one entry per
// generation to the chat's metadata. Regenerating / swiping the same floor
// replaces that floor's entry instead of counting twice.

export const META_KEY = 'memory_lens_tokens';
/** Fired on window after a new entry is recorded. */
export const TOKENS_EVENT = 'memory-lens:tokens';
const MAX_ENTRIES = 500;
const END_EVENTS = ['GENERATION_ENDED', 'GENERATION_STOPPED'];

/** Adds an entry; an entry for the same floor replaces the previous one. */
export function addEntry(entries, entry, max = MAX_ENTRIES) {
    const list = Array.isArray(entries) ? entries.slice() : [];
    const last = list[list.length - 1];
    if (last && entry.floor >= 0 && last.floor === entry.floor) list[list.length - 1] = entry;
    else list.push(entry);
    return list.length > max ? list.slice(list.length - max) : list;
}

/**
 * @param {{ core: number, focus: number }[]} entries
 * @returns {{ count, total, avg, max, avgFocus, avgCore }}
 */
export function summarize(entries) {
    const list = Array.isArray(entries) ? entries : [];
    let total = 0;
    let focus = 0;
    let core = 0;
    let max = 0;
    for (const e of list) {
        const sum = (e.core || 0) + (e.focus || 0);
        total += sum;
        focus += e.focus || 0;
        core += e.core || 0;
        max = Math.max(max, sum);
    }
    const count = list.length;
    const avg = (n) => (count ? Math.round(n / count) : 0);
    return { count, total, avg: avg(total), max, avgFocus: avg(focus), avgCore: avg(core) };
}

export async function countTokens(ctx, text) {
    const value = String(text || '');
    if (!value.trim()) return 0;
    try {
        if (typeof ctx.getTokenCountAsync === 'function') return await ctx.getTokenCountAsync(value);
    } catch { /* fall through */ }
    // Rough fallback: CJK ≈ 1 token per char, other text ≈ 4 chars per token.
    const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    return Math.round(cjk + (value.length - cjk) / 4);
}

export function readEntries(ctx) {
    const meta = ctx?.chatMetadata?.[META_KEY];
    return Array.isArray(meta?.entries) ? meta.entries : [];
}

export function clearEntries(ctx) {
    if (!ctx?.chatMetadata) return;
    ctx.chatMetadata[META_KEY] = { v: 1, entries: [] };
    ctx.saveMetadataDebounced?.();
}

/** Index of the last user message: the floor this generation answers. */
function currentFloor(ctx) {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    for (let i = chat.length - 1; i >= 0; i--) if (chat[i]?.is_user) return i;
    return chat.length - 1;
}

/**
 * Starts recording. Safe to call before memory-graph is ready; it looks the
 * API up on each generation. Returns a stop function.
 */
export function startRecorder(getCtx, { onRecord = null } = {}) {
    let lastAt = 0;
    let busy = false;
    const offs = [];

    async function check() {
        if (busy) return;
        busy = true;
        try {
            const ctx = getCtx();
            const mg = ctx?.getExtensionApi?.('memory-graph');
            if (!ctx?.chatMetadata || typeof mg?.getLastRecallProjection !== 'function') return;
            const projection = await mg.getLastRecallProjection(ctx);
            const at = Number(projection?.at || 0);
            const known = readEntries(ctx);
            if (!at || at === lastAt || known.some(e => e.at === at)) { lastAt = at || lastAt; return; }
            lastAt = at;
            const [core, focus] = await Promise.all([
                countTokens(ctx, projection.blocks?.corePacket),
                countTokens(ctx, projection.blocks?.focusPacket),
            ]);
            const entry = { at, floor: currentFloor(ctx), core, focus };
            ctx.chatMetadata[META_KEY] = { v: 1, entries: addEntry(readEntries(ctx), entry) };
            ctx.saveMetadataDebounced?.();
            onRecord?.(entry);
            globalThis.dispatchEvent?.(new CustomEvent(TOKENS_EVENT, { detail: entry }));
        } catch (err) {
            console.warn('[memory-graph/lens] token record failed', err);
        } finally {
            busy = false;
        }
    }

    try {
        const ctx = getCtx();
        const types = ctx.eventTypes || ctx.event_types || {};
        for (const name of END_EVENTS) {
            const type = types[name];
            if (!type || !ctx.eventSource?.on) continue;
            // Let memory-graph finish persisting the projection first.
            const handler = () => setTimeout(check, 300);
            ctx.eventSource.on(type, handler);
            offs.push(() => ctx.eventSource.removeListener?.(type, handler));
        }
    } catch { /* no host */ }
    return () => { for (const off of offs.splice(0)) off(); };
}
