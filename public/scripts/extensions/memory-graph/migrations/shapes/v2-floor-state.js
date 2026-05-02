/**
 * Terminal shape: data namespace is in v2 floor-state layout.
 *
 * Detection requires that `data` does NOT contain an `opLog` array — this
 * guards against interrupted migrations where __meta got stamped but the
 * v8 → v2 translation crashed before clearing data. In that case we want
 * v8-oplog to take precedence and re-run.
 */

export const v2FloorState = Object.freeze({
    id: 'v2-floor-state',
    detect(input) {
        const data = input?.data;
        if (data && typeof data === 'object' && Array.isArray(data.opLog)) {
            return false;
        }
        if (input?.meta && Number(input.meta.schemaVersion || 0) >= 2) {
            return true;
        }
        if (Array.isArray(input?.log?.commits) && input.log.commits.length > 0) {
            return true;
        }
        return false;
    },
    migrate: null,
    nextId: null,
});
