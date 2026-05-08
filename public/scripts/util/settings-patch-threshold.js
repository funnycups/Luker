const DEFAULT_OPS_THRESHOLD = 256;

/**
 * Decide whether a freshly-computed RFC 6902 operation list is a good fit for
 * the `/api/settings/patch` endpoint. When this returns false, callers should
 * fall back to the full-save path (`/api/settings/save`).
 *
 * The previous implementation `JSON.stringify`-ed both the operations payload
 * and the full settings payload just to compare their byte lengths. That
 * second stringify of the entire settings tree is costly on the main thread.
 * For typical edits the operation count is the dominant predictor of which
 * body is smaller — when ops are few, the patch body is virtually always
 * smaller; when ops are many, the patch overhead approaches or exceeds the
 * full payload.
 *
 * The empty-path "replace" sentinel emitted by the diff worker when the
 * operation count exceeds maxOperations is also rejected here — applying it
 * is equivalent to a full save with extra wrapping overhead.
 *
 * @param {Array<{op?: string, path?: string}>} operations
 * @param {number} [threshold=256] Operation-count cutoff above which full save
 *   is preferred.
 * @returns {boolean} True iff the patch endpoint should be used.
 */
export function shouldUseSettingsPatch(operations, threshold = DEFAULT_OPS_THRESHOLD) {
    if (!Array.isArray(operations) || operations.length === 0) {
        return false;
    }
    if (operations.length === 1
        && operations[0]?.op === 'replace'
        && operations[0]?.path === '') {
        return false;
    }
    if (!Number.isFinite(threshold) || threshold <= 0) {
        return false;
    }
    return operations.length <= threshold;
}

export const SETTINGS_PATCH_OPS_THRESHOLD = DEFAULT_OPS_THRESHOLD;
