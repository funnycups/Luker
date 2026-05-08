/**
 * Compute an estimated total token count for currently-enabled prompts using
 * the per-prompt cache populated by the previous dry-run.
 *
 * The result is intentionally an estimate: it sums cached values for prompts
 * whose enabled flag is true and whose cached count is a positive finite number.
 * Prompts that have never been tokenized (cache undefined / null / 0) contribute
 * zero — the caller is expected to display them as "-" until the next dry-run
 * populates real values.
 *
 * @param {Array<{identifier?: string, enabled?: boolean}>} promptOrder
 *   Prompt-order entries for the active character.
 * @param {Record<string, number|null|undefined>} counts
 *   Per-prompt token-count cache, typically `tokenHandler.getCounts()`.
 * @returns {number} Estimated total tokens for enabled prompts.
 */
export function estimateTotalTokensFromCache(promptOrder, counts) {
    if (!Array.isArray(promptOrder) || !counts || typeof counts !== 'object') {
        return 0;
    }
    let total = 0;
    for (const entry of promptOrder) {
        if (!entry || !entry.enabled) continue;
        const identifier = entry.identifier;
        if (typeof identifier !== 'string' || identifier.length === 0) continue;
        const value = counts[identifier];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            total += value;
        }
    }
    return total;
}
