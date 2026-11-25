/** Merge already-packed source scopes using the runtime export precedence. */
export function mergePackedSkillItems(groups) {
    const precedence = { global: 0, preset: 1, 'orch-preset': 2 };
    const dedup = new Map();
    for (const { scope, payload } of groups) {
        const kindRank = precedence[scope.kind];
        if (kindRank === undefined || !Array.isArray(payload?.items)) continue;
        for (const item of payload.items) {
            if (!item || typeof item !== 'object' || !item.name) continue;
            const prev = dedup.get(item.name);
            if (!prev || prev.kindRank < kindRank) dedup.set(item.name, { kindRank, item });
        }
    }
    return [...dedup.values()].map(value => value.item);
}
