/**
 * Defensive: raw runtime-store shape sitting in chat-state.
 *
 * Pre-v8 memory-graph variants stored the runtime store directly in the
 * data namespace (`{ version: 5, nodes, edges, ... lastRecallTrace, ... }`).
 * This shape never appeared in this repo's history (chat-state has been
 * v8 opLog since the initial commit), but upstream forks may have written
 * it, and stamping schemaVersion=2 without translating would silently
 * lose the lastRecallTrace / lastRecallProjection / sourceMessageCount
 * fields that live on the data namespace.
 *
 * Strategy: encode the raw store's nodes/edges into a single opLog entry,
 * preserve the metadata fields on input.data, and let v8-oplog do the
 * actual floor-state translation.
 *
 * `buildMemoryLogOpsFromStore` and `getStoreCoveredSeqTo` are injected via
 * ctx (rather than directly imported from `../../persistence.js`) because
 * `persistence.js` already imports `migrations/index.js`; pulling those
 * helpers in directly here would close a static-import cycle that the ES
 * module loader rejects when registry.js evaluates the SHAPES array.
 */

export const v5Raw = Object.freeze({
    id: 'v5-raw',
    detect(input) {
        if (input?.meta && Number(input.meta.schemaVersion || 0) >= 2) return false;
        const d = input?.data;
        if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
        if (Array.isArray(d.opLog)) return false;
        const hasNodes = d.nodes && typeof d.nodes === 'object' && !Array.isArray(d.nodes)
            && Object.keys(d.nodes).length > 0;
        const hasEdges = Array.isArray(d.edges) && d.edges.length > 0;
        return hasNodes || hasEdges;
    },
    async migrate(input, ctx) {
        const ops = ctx.buildMemoryLogOpsFromStore(input.data);
        const seq = ctx.getStoreCoveredSeqTo(input.data);
        const opLog = (seq > 0 || ops.length > 0)
            ? [{ seq: Math.max(0, Math.floor(seq)), ops }]
            : [];
        return {
            ...input,
            data: {
                ...input.data,
                version: 8,
                opLog,
                coveredSeqTo: seq,
            },
        };
    },
    nextId: 'v8-oplog',
});
