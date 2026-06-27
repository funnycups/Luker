/**
 * Skill embed export helper.
 *
 * Pack the relevant scope's skills into an `embedded_skills_source` payload
 * suitable for sticking onto a character card or preset before download.
 *
 * Used by:
 *   - Character export ("Include skills" checkbox in the card export flow)
 *   - Preset export ("Include skills" checkbox in the OAI preset export flow)
 *
 * The actual payload packing happens server-side via the existing
 * `packForEmbed` route (which round-trips through the SkillRepository for
 * file reads + base64 archive encoding). This module just orchestrates:
 *   1. List skills in the target scope.
 *   2. If none, return null (no payload to attach).
 *   3. Otherwise call `context.skills.packForEmbed(...)` with the names.
 *   4. Return the payload object — the caller is responsible for merging
 *      it into the export JSON at `extensions.luker.embedded_skills_source`.
 *
 * Convention chosen to mirror the regex/world-info embedded-script pattern:
 * the asset author opts in via a checkbox; an empty scope yields a null
 * payload so the asset JSON doesn't get bloated with an empty `items: []`.
 */

/**
 * Pack all skills in `targetScope` into an embed payload. Returns null when
 * the scope has no skills.
 *
 * @param {object} opts
 * @param {object} opts.context - SillyTavern context (needs `skills`)
 * @param {object} opts.targetScope - the scope to pack from
 * @param {'inline-files-v1'|'archive-base64-v1'|'auto'} [opts.mode='auto']
 *   - inline keeps text-only payloads readable in the asset JSON
 *   - archive packs binaries (used when any skill has binary files)
 *   - auto lets the server pick per-skill based on size + binary content
 * @returns {Promise<object|null>} the embed payload, or null if scope is empty
 */
export async function packSkillsForExport({ context, targetScope, mode = 'auto' } = {}) {
    if (!context || !context.skills) {
        throw new Error('packSkillsForExport: context.skills missing');
    }
    if (!targetScope || typeof targetScope !== 'object') {
        throw new Error('packSkillsForExport: targetScope missing');
    }
    const list = await context.skills.list({ scope: targetScope });
    const names = (Array.isArray(list) ? list : [])
        .map(s => (s && typeof s.name === 'string') ? s.name : null)
        .filter(Boolean);
    if (names.length === 0) return null;
    return context.skills.packForEmbed({ scope: targetScope, names, mode });
}

/**
 * Attach an embed payload to a parsed character/preset object at the
 * canonical path `extensions.luker.embedded_skills_source`. Mutates the
 * target in place and returns it for chaining. A null payload is a no-op
 * (used when the user opts out or the scope has no skills).
 *
 * For character cards, the payload lives at `character.data.extensions.luker`
 * (the inner `.data` wrapper is the v2/v3 card-spec envelope). Caller must
 * pass the object that contains `.extensions` (i.e. `character.data` for
 * characters, or the preset object directly for presets).
 *
 * @template {object} T
 * @param {T} target - the object that owns `extensions` (mutates in place)
 * @param {object|null} payload - the embed payload (or null to skip)
 * @returns {T}
 */
export function attachEmbeddedSkillsSource(target, payload) {
    if (!target || typeof target !== 'object') return target;
    if (!payload || typeof payload !== 'object') return target;
    if (!target.extensions || typeof target.extensions !== 'object') {
        target.extensions = {};
    }
    if (!target.extensions.luker || typeof target.extensions.luker !== 'object') {
        target.extensions.luker = {};
    }
    target.extensions.luker.embedded_skills_source = payload;
    return target;
}

/**
 * Convenience wrapper used by the character/preset export hooks. Packs the
 * target scope and (if non-empty) attaches the payload to the target object.
 * No-op when the scope is empty.
 *
 * @param {object} opts
 * @param {object} opts.context
 * @param {object} opts.targetScope
 * @param {object} opts.attachTo - the object whose `extensions.luker.embedded_skills_source`
 *   will be populated (e.g. `character.data` or the preset body)
 * @param {'inline-files-v1'|'archive-base64-v1'|'auto'} [opts.mode='auto']
 * @returns {Promise<object|null>} the payload that was attached, or null if none
 */
export async function packAndAttachSkillsForExport({ context, targetScope, attachTo, mode = 'auto' } = {}) {
    const payload = await packSkillsForExport({ context, targetScope, mode });
    if (!payload) return null;
    attachEmbeddedSkillsSource(attachTo, payload);
    return payload;
}
