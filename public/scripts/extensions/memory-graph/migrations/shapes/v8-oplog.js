/**
 * v8 opLog → v2 floor-state translator.
 *
 * The legacy chat-state held one record with `{ version: 8, opLog,
 * coveredSeqTo, swipeTailCache, lastRecallTrace, lastRecallProjection,
 * sourceMessageCount }`. This shape replays each opLog entry into a
 * cumulative graph payload, emitting one snapshot-style commit per entry
 * tagged at the entry's resolved (floor, swipeId).
 *
 * Snapshot-from-empty patches (rather than incremental diffs) because
 * floor-state filters surviving commits by (floor, swipeId) on swipe /
 * delete events; an isolated incremental commit would silently fail to
 * apply against an empty data namespace.
 *
 * Drops `swipeTailCache` — the (floor, swipeId) commit filter replaces it.
 */

// Inlined locally to avoid a v8-oplog → persistence.js → migrations/index.js
// → registry.js → v8-oplog cycle once persistence.js depends on the
// migration pipeline. Mirrors `getFloorFromAssistantSeq` in persistence.js.
function getFloorFromAssistantSeq(chat, assistantSeq, isExtractableAssistantMessage) {
    const target = Math.floor(Number(assistantSeq || 0));
    if (!Number.isInteger(target) || target <= 0) return null;
    const source = Array.isArray(chat) ? chat : [];
    let count = 0;
    for (let i = 0; i < source.length; i++) {
        if (!isExtractableAssistantMessage(source[i])) continue;
        count += 1;
        if (count === target) return i;
    }
    return null;
}

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
        let cumulative = emptyGraphPayload();
        const commits = [];
        for (const entry of opLog) {
            if (!entry || typeof entry !== 'object') continue;
            const seq = sanitizeSeq(entry.seq);
            const floor = getFloorFromAssistantSeq(ctx.chat, seq, ctx.isExtractableAssistantMessage);
            if (!Number.isInteger(floor) || floor < 0) continue;
            const next = structuredClone(cumulative);
            ctx.applyMemoryLogEntryToStore(next, entry);
            next.coveredAssistantSeq = Math.max(next.coveredAssistantSeq, seq);
            const patches = await ctx.buildObjectPatchOperationsAsync({}, next);
            if (Array.isArray(patches) && patches.length > 0) {
                const swipeId = sanitizeSwipeId(ctx.chat[floor]?.swipe_id);
                commits.push({ floor, swipeId, patches });
            }
            cumulative = next;
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
