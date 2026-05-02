/**
 * v8 opLog → v2 floor-state translator.
 *
 * The legacy chat-state held one record with `{ version: 8, opLog,
 * coveredSeqTo, swipeTailCache, lastRecallTrace, lastRecallProjection,
 * sourceMessageCount }`. This shape replays each opLog entry into a
 * cumulative graph payload, emitting one commit per entry tagged at the
 * entry's resolved (floor, swipeId).
 *
 * Patches are INCREMENTAL (`prev → next` per entry), not snapshot-from-empty.
 * Floor-state's deletion semantics are tail-only (truncate at floor F drops
 * commits at floor >= F; swipe deletion only happens at the chat tail), so
 * surviving commits on the active replay path always form a contiguous
 * chain and incremental patches compose cleanly. Snapshot-from-empty was
 * over-engineered for a middle-skip case that doesn't exist; it grew log
 * size O(N×state) — 19MB log for ~1MB of source data.
 *
 * Drops `swipeTailCache` — the (floor, swipeId) commit filter replaces it.
 */

function emptyGraphPayload() {
    return {
        nodes: {},
        edges: [],
        nodeSeq: 0,
        seqCounter: 0,
        appliedSeqTo: 0,
        loggedSeqTo: 0,
        coveredAssistantSeq: 0,
    };
}

function sanitizeSeq(value) {
    return Math.max(0, Math.floor(Number(value || 0)));
}

function sanitizeSwipeId(value) {
    return Number.isInteger(value) && value >= 0 ? value : 0;
}

function sanitizeNumber(value) {
    return Math.max(0, Number(value || 0));
}

function sanitizeArray(value) {
    return Array.isArray(value) ? structuredClone(value) : [];
}

function sanitizeProjection(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? structuredClone(value)
        : null;
}

export const v8Oplog = Object.freeze({
    id: 'v8-oplog',
    detect(input) {
        return Array.isArray(input?.data?.opLog);
    },
    async migrate(input, ctx) {
        const opLog = input.data.opLog;
        // `cumulative` doubles as the running materialized state and as the
        // `prev` for the next iteration's diff. Starts as `{}` so the first
        // commit's patches add the default scaffolding (nodes, edges, …) —
        // floor-state replay starts from `{}` and needs that first commit
        // to seed the structure.
        let cumulative = {};
        const commits = [];
        for (const entry of opLog) {
            if (!entry || typeof entry !== 'object') continue;
            const seq = sanitizeSeq(entry.seq);
            const floor = ctx.getFloorFromAssistantSeq(ctx.chat, seq, ctx.isExtractableAssistantMessage);
            if (!Number.isInteger(floor) || floor < 0) continue;
            const next = structuredClone({ ...emptyGraphPayload(), ...cumulative });
            ctx.applyMemoryLogEntryToStore(next, entry);
            next.coveredAssistantSeq = Math.max(Number(next.coveredAssistantSeq || 0), seq);
            const patches = await ctx.buildObjectPatchOperationsAsync(cumulative, next);
            if (Array.isArray(patches) && patches.length > 0) {
                const swipeId = sanitizeSwipeId(ctx.chat[floor]?.swipe_id);
                commits.push({ floor, swipeId, patches });
                cumulative = next;
            }
        }
        return {
            data: cumulative,
            log: { version: ctx.FLOOR_STATE_LOG_VERSION, commits },
            meta: {
                schemaVersion: ctx.SCHEMA_VERSION,
                sourceMessageCount: sanitizeNumber(input.data.sourceMessageCount),
                lastRecallTrace: sanitizeArray(input.data.lastRecallTrace),
                lastRecallProjection: sanitizeProjection(input.data.lastRecallProjection),
            },
        };
    },
    nextId: 'v2-floor-state',
});
