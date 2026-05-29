// Extracts world-info hits from SillyTavern's resolveWorldInfoForMessages
// result for display in the simulation-review popup. The runtimeWorldInfo
// arg shape comes from public/scripts/st-context.js (resolveWorldInfoForMessages):
//
//   {
//     worldInfoBeforeEntries: string[],  // pre-formatted activation text
//     worldInfoAfterEntries:  string[],
//     worldInfoDepth: [{ depth, role, entries: string[] }],
//     activatedEntries: [{ world, comment, uid, position, depth, role, ... }],  // optional
//     ...
//   }
//
// Prefer activatedEntries[] (per-entry book + comment attribution). Fall
// back to the legacy pre-formatted strings if the runtime didn't surface
// activatedEntries — this keeps us safe across host versions.

/**
 * @typedef {object} ActivatedWorldInfoEntry
 * @property {string} [world] Lorebook name.
 * @property {string} [comment] Entry's comment / title.
 * @property {string|number} [uid] Entry id.
 * @property {number} [position] world_info_position enum: 0=before, 1=after, 2=ANTop, 3=ANBottom, 4=atDepth.
 * @property {number} [depth] For position=atDepth.
 * @property {number} [role] For position=atDepth: 0=system, 1=user, 2=assistant.
 */

/**
 * @typedef {object} WorldInfoHit
 * @property {string} book Lorebook name.
 * @property {string} entry Entry's comment / title (or pre-formatted text fallback).
 * @property {string} comment Same as entry's comment when known, otherwise empty.
 * @property {string} position Human-readable position tag (e.g. "before-char", "depth-4/system").
 */

/**
 * Extract per-entry attribution hits from a resolveWorldInfoForMessages return value.
 * @param {object} runtimeWorldInfo
 * @returns {WorldInfoHit[]}
 */
export function extractWorldInfoHitsFromRuntime(runtimeWorldInfo) {
    if (!runtimeWorldInfo || typeof runtimeWorldInfo !== 'object') return [];
    const activated = Array.isArray(runtimeWorldInfo.activatedEntries) ? runtimeWorldInfo.activatedEntries : [];
    if (activated.length > 0) {
        const hits = [];
        for (const entry of activated) {
            if (!entry || typeof entry !== 'object') continue;
            const book = String(entry.world || '').trim();
            const comment = String(entry.comment || '').trim();
            hits.push({
                book,
                entry: comment,
                comment,
                position: worldInfoPositionLabel(entry),
            });
        }
        return hits;
    }
    return extractLegacyWorldInfoHits(runtimeWorldInfo);
}

/**
 * Map an activated entry's numeric position/role into a stable label
 * the popup can render directly.
 * @param {ActivatedWorldInfoEntry} entry
 * @returns {string}
 */
function worldInfoPositionLabel(entry) {
    if (!entry || typeof entry !== 'object') return '';
    const position = Number(entry.position);
    if (position === 4) {
        const depth = Math.max(0, Math.floor(Number(entry.depth) || 0));
        const role = normalizeDepthRole(entry.role);
        return role ? `depth-${depth}/${role}` : `depth-${depth}`;
    }
    if (position === 0) return 'before-char';
    if (position === 1) return 'after-char';
    if (position === 2) return 'AN-top';
    if (position === 3) return 'AN-bottom';
    if (position === 5) return 'EM-top';
    if (position === 6) return 'EM-bottom';
    if (position === 7) {
        const outlet = String(entry.outletName || '').trim();
        return outlet ? `outlet/${outlet}` : 'outlet';
    }
    return String(entry.position ?? '');
}

/**
 * Normalize an activated-entry role into the system/user/assistant labels
 * the rest of the runtime uses. Accepts the numeric extension_prompt_roles
 * enum (0=system, 1=user, 2=assistant) and the equivalent strings.
 * @param {number|string|null|undefined} role
 * @returns {string}
 */
function normalizeDepthRole(role) {
    if (role === null || role === undefined || role === '') return 'system';
    const numeric = Number(role);
    if (Number.isFinite(numeric)) {
        if (numeric === 1) return 'user';
        if (numeric === 2) return 'assistant';
        return 'system';
    }
    const text = String(role).toLowerCase();
    if (text === 'user') return 'user';
    if (text === 'assistant') return 'assistant';
    return 'system';
}

/**
 * Legacy walker: when activatedEntries[] isn't on the runtime, walk
 * the pre-formatted text buckets and emit anonymous hits so the popup
 * still has something to show. The book name is left blank because the
 * legacy shape doesn't retain it.
 * @param {object} runtimeWorldInfo
 * @returns {WorldInfoHit[]}
 */
function extractLegacyWorldInfoHits(runtimeWorldInfo) {
    const hits = [];
    const before = Array.isArray(runtimeWorldInfo.worldInfoBeforeEntries) ? runtimeWorldInfo.worldInfoBeforeEntries : [];
    for (const text of before) {
        const entry = String(text || '').trim();
        if (!entry) continue;
        hits.push({ book: '', entry, comment: '', position: 'before-char' });
    }
    const after = Array.isArray(runtimeWorldInfo.worldInfoAfterEntries) ? runtimeWorldInfo.worldInfoAfterEntries : [];
    for (const text of after) {
        const entry = String(text || '').trim();
        if (!entry) continue;
        hits.push({ book: '', entry, comment: '', position: 'after-char' });
    }
    const depthBuckets = Array.isArray(runtimeWorldInfo.worldInfoDepth) ? runtimeWorldInfo.worldInfoDepth : [];
    for (const bucket of depthBuckets) {
        const depthVal = Math.max(0, Math.floor(Number(bucket?.depth) || 0));
        const role = normalizeDepthRole(bucket?.role);
        const entries = Array.isArray(bucket?.entries) ? bucket.entries : [];
        for (const text of entries) {
            const entry = String(text || '').trim();
            if (!entry) continue;
            hits.push({ book: '', entry, comment: '', position: `depth-${depthVal}/${role}` });
        }
    }
    return hits;
}
