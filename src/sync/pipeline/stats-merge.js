export const STATS_PATH = 'stats.json';

/** Counters `calculateStats` builds per character in `src/endpoints/stats.js`. */
export const STATS_COUNTER_FIELDS = Object.freeze([
    'total_gen_time',
    'user_word_count',
    'non_user_word_count',
    'user_msg_count',
    'non_user_msg_count',
    'total_swipe_count',
    'chat_size',
]);

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * Three-way merge of stats.json documents. The document is derived from
 * chats and can be recomputed with "Refresh Stat File"; both devices count
 * the same synced chats, so the larger counter is the more complete count
 * and the merge never needs a conflict record. A key in `base` missing on
 * either side is removed. `timestamp` takes the maximum. A character on
 * both sides takes the field-wise maximum of each counter and of
 * `date_last_chat`, the smallest non-zero `date_first_chat`, and ours for
 * any other field. A side that is not an object counts as empty.
 *
 * @param {unknown} base
 * @param {unknown} ours
 * @param {unknown} theirs
 * @returns {object} keys in a deterministic order
 */
export function mergeStatsDocuments(base, ours, theirs) {
    const b = isObject(base) ? base : {};
    const o = isObject(ours) ? ours : {};
    const t = isObject(theirs) ? theirs : {};
    const out = [];
    for (const key of [...new Set([...Object.keys(o), ...Object.keys(t)])].sort()) {
        const inOurs = Object.hasOwn(o, key);
        const inTheirs = Object.hasOwn(t, key);
        if (Object.hasOwn(b, key) && (!inOurs || !inTheirs)) continue;
        if (key === 'timestamp') {
            out.push([key, Math.max(num(o.timestamp), num(t.timestamp))]);
            continue;
        }
        const a = inOurs ? o[key] : undefined;
        const c = inTheirs ? t[key] : undefined;
        out.push([key, isObject(a) && isObject(c) ? mergeCharacterStats(a, c) : inOurs ? a : c]);
    }
    return Object.fromEntries(out);
}

function mergeCharacterStats(a, c) {
    const merged = { ...c, ...a };
    for (const field of STATS_COUNTER_FIELDS) {
        if (Object.hasOwn(a, field) || Object.hasOwn(c, field)) merged[field] = Math.max(num(a[field]), num(c[field]));
    }
    if (Object.hasOwn(a, 'date_last_chat') || Object.hasOwn(c, 'date_last_chat')) {
        merged.date_last_chat = Math.max(num(a.date_last_chat), num(c.date_last_chat));
    }
    if (Object.hasOwn(a, 'date_first_chat') || Object.hasOwn(c, 'date_first_chat')) {
        const firsts = [num(a.date_first_chat), num(c.date_first_chat)].filter(value => value > 0);
        merged.date_first_chat = firsts.length > 0 ? Math.min(...firsts) : 0;
    }
    return merged;
}
