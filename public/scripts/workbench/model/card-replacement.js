// SPDX-License-Identifier: AGPL-3.0-or-later

const CARD_FIELDS = [
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions', 'tags', 'creator',
    'character_version', 'alternate_greetings',
];
const ENTRY_FIELDS = [
    'comment', 'content', 'key', 'keysecondary', 'constant', 'selective', 'disable',
    'position', 'order', 'depth', 'probability',
];

export function formatReplacementValue(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(formatReplacementValue).join('\n');
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
}

function cardField(character, field) {
    if (field === 'creator_notes') {
        return formatReplacementValue(character?.data?.creator_notes ?? character?.creatorcomment ?? character?.creator_notes);
    }
    return formatReplacementValue(character?.data?.[field] ?? character?.[field]);
}

export function buildReplaceDiffModel(context) {
    const previous = context?.previousCharacter;
    const next = context?.nextCharacter;
    const previousBook = context?.previousLorebookSnapshot;
    const nextBook = context?.nextLorebookData;
    const fields = CARD_FIELDS.flatMap(key => {
        const before = cardField(previous, key);
        const after = cardField(next, key);
        return before === after ? [] : [{ key, previous: before, next: after }];
    });
    const previousName = String(previousBook?.bookName || previous?.data?.extensions?.world || '').trim();
    const nextName = String(next?.data?.extensions?.world || '').trim();
    const beforeEntries = previousBook?.entries || {};
    const afterEntries = nextBook?.entries || {};
    const removed = [];
    const added = [];
    const changed = [];
    let unchangedCount = 0;
    for (const [uid, entry] of Object.entries(beforeEntries)) {
        if (!Object.hasOwn(afterEntries, uid)) removed.push({ uid, entry });
    }
    for (const [uid, entry] of Object.entries(afterEntries)) {
        if (!Object.hasOwn(beforeEntries, uid)) {
            added.push({ uid, entry });
            continue;
        }
        const before = beforeEntries[uid];
        const changedFields = ENTRY_FIELDS.filter(field => (
            formatReplacementValue(before[field]) !== formatReplacementValue(entry[field])
        ));
        if (changedFields.length) changed.push({ uid, previous: before, next: entry, changedFields });
        else unchangedCount++;
    }
    const renamed = Boolean(previousName && nextName && previousName !== nextName);
    return {
        hasChanges: Boolean(fields.length || added.length || removed.length || changed.length || renamed),
        card: {
            previousName: String(previous?.name || previous?.data?.name || ''),
            nextName: String(next?.name || next?.data?.name || ''),
            fields,
        },
        book: { previousName, nextName, renamed, added, removed, changed, unchangedCount },
    };
}
