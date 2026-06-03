/**
 * Skill embed lifecycle (Plan 2 Unit 5).
 *
 * Wires `extensions.luker.embedded_skills_source` import/export + scope-skill
 * cleanup to the existing Luker character + preset lifecycle events. Follows
 * the same pattern as the regex extension's embedded-script flow (see
 * public/scripts/extensions/regex/index.js — `checkCharEmbeddedRegexScripts`,
 * `checkPresetEmbeddedRegexScripts`, `purgeEmbeddedRegexScripts`).
 *
 * Hooks installed (idempotent — guarded against double-registration):
 *
 *   - CHAT_CHANGED → check the active character for embedded skills payload;
 *     if present and not previously seen, surface the import dialog. Default
 *     targetScope is the character's own scope.
 *   - OAI_PRESET_IMPORT_READY → check the freshly-loaded preset body for an
 *     embedded payload; if present, surface the import dialog with preset
 *     scope (keyed by preset name only — preset-scope skills are decoupled
 *     from any specific connection profile).
 *   - CHARACTER_DELETED → cascade-delete every skill in that character's
 *     scope. The character's `avatar` is the characterFile id.
 *   - PRESET_DELETED → cascade-delete every preset-scope skill keyed on the
 *     deleted preset's `name`.
 *
 * Card-bound preset materialization to character scope (spec §3.3): if a
 * character card embeds BOTH its own skills payload AND a card-bound preset
 * with its own payload, both go into character scope (they share the
 * character's lifecycle). Implemented in `extractCharacterPayloads`.
 *
 * The "have we already prompted for this asset?" memory uses Luker's
 * `accountStorage` (the same store regex uses for `AlertRegex_*`). Keys:
 *   - `AlertSkills_<avatar>` — character-scope embedded skills prompt
 *   - `AlertSkills_preset_<presetName>` — preset-scope embedded skills prompt
 *
 * The accountStorage flag is removed on delete so a re-imported asset
 * surfaces the dialog again.
 */

import { runEmbedImportFlow, getEmbeddedSkillsSource } from './embed-import-dialog.js';

const CHARACTER_PROMPT_KEY = (avatar) => `AlertSkills_${avatar}`;
const PRESET_PROMPT_KEY = (name) => `AlertSkills_preset_${name}`;

/**
 * Pluck the embedded_skills_source payloads from a character object. Returns
 * 0, 1, or 2 entries:
 *   - The character's own payload at `character.data.extensions.luker.embedded_skills_source`
 *   - The card-bound preset's payload at `character.data.extensions.luker.bound_preset?.extensions.luker.embedded_skills_source`
 *     (per spec §3.3 the bound-preset payload materializes to character scope
 *     because it shares the character's lifecycle)
 *
 * The bound-preset path is a best-effort read — Luker's card-bound preset
 * shape isn't part of the v2/v3 card spec, so we accept either of two
 * plausible locations and skip silently if neither matches.
 *
 * @param {object} character - characters[chid] entry
 * @returns {Array<object>} payloads to materialize
 */
export function extractCharacterPayloads(character) {
    const out = [];
    const cardData = character?.data;
    const own = getEmbeddedSkillsSource(cardData);
    if (own) out.push(own);
    // Card-bound preset (a Luker-specific concept) may live under a few
    // plausible paths; we try the canonical one first then a fallback.
    const candidates = [
        cardData?.extensions?.luker?.bound_preset,
        cardData?.extensions?.luker?.preset,
    ];
    for (const candidate of candidates) {
        const sub = getEmbeddedSkillsSource(candidate);
        if (sub) out.push(sub);
    }
    return out;
}

/**
 * Merge two or more embed payloads into a single payload by concatenating
 * their items. Items keep their original conflict identity (name is unique
 * within a scope after the dedupe inside the SkillRepository).
 *
 * @param {Array<object>} payloads
 * @returns {object|null}
 */
export function mergePayloads(payloads) {
    if (!Array.isArray(payloads) || payloads.length === 0) return null;
    if (payloads.length === 1) return payloads[0];
    const items = [];
    for (const p of payloads) {
        if (Array.isArray(p?.items)) items.push(...p.items);
    }
    return { version: 1, items };
}

/**
 * Cascade-delete all skills in a scope. Used by the character and preset
 * delete hooks. Failures on individual deletions are swallowed (logged)
 * so a single broken skill can't block the rest of the cleanup.
 *
 * @param {object} opts
 * @param {object} opts.context
 * @param {object} opts.scope
 * @returns {Promise<{deleted: number, failed: number}>}
 */
export async function cascadeDeleteSkillsInScope({ context, scope } = {}) {
    if (!context || !context.skills) return { deleted: 0, failed: 0 };
    if (!scope || typeof scope !== 'object') return { deleted: 0, failed: 0 };
    let list;
    try {
        list = await context.skills.list({ scope });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[skill-embed-lifecycle] cascade-delete list failed:', e?.message || e);
        return { deleted: 0, failed: 0 };
    }
    if (!Array.isArray(list) || list.length === 0) return { deleted: 0, failed: 0 };
    let deleted = 0;
    let failed = 0;
    for (const skill of list) {
        if (!skill || typeof skill.name !== 'string') continue;
        try {
            await context.skills.delete(scope, skill.name);
            deleted += 1;
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(`[skill-embed-lifecycle] cascade-delete failed for ${skill.name}:`, e?.message || e);
            failed += 1;
        }
    }
    return { deleted, failed };
}

/**
 * Per-character-import check, mounted on CHAT_CHANGED. Runs the import
 * dialog if the active character has an embedded skills payload and the
 * user hasn't already responded to it for this avatar.
 *
 * @param {object} opts
 * @param {object} opts.context
 * @param {(s:string)=>string} [opts.t]
 */
export async function checkCharEmbeddedSkills({ context, t = (s) => s } = {}) {
    if (!context?.characters || context.characterId === undefined || context.characterId === null) {
        return;
    }
    const character = context.characters[context.characterId];
    const avatar = character && typeof character.avatar === 'string' ? character.avatar : '';
    if (!avatar) return;

    const payloads = extractCharacterPayloads(character);
    if (payloads.length === 0) return;

    const accountStorage = context.accountStorage || globalThis.accountStorage;
    const promptKey = CHARACTER_PROMPT_KEY(avatar);
    if (accountStorage && accountStorage.getItem && accountStorage.getItem(promptKey)) {
        return;
    }
    if (accountStorage && accountStorage.setItem) {
        accountStorage.setItem(promptKey, 'true');
    }

    const merged = mergePayloads(payloads);
    if (!merged) return;
    const targetScope = { kind: 'character', characterFile: avatar };
    try {
        await runEmbedImportFlow({ context, payload: merged, targetScope, t });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[skill-embed-lifecycle] character embed import failed:', e?.message || e);
    }
}

/**
 * Per-preset-import check, mounted on OAI_PRESET_IMPORT_READY. The event
 * fires synchronously inside `onPresetImportFileChange`, with the parsed
 * preset body in `event.data`. We pull the embedded payload (if any) and
 * surface the dialog with `{kind:'preset', name: presetName}`.
 *
 * @param {object} event - { data: presetBody, presetName: string }
 * @param {object} opts
 * @param {object} opts.context
 * @param {(s:string)=>string} [opts.t]
 */
export async function checkPresetEmbeddedSkills(event, { context, t = (s) => s } = {}) {
    const presetBody = event?.data;
    const presetName = String(event?.presetName || '').trim();
    if (!presetBody || !presetName) return;

    const payload = getEmbeddedSkillsSource(presetBody);
    if (!payload) return;

    const accountStorage = context?.accountStorage || globalThis.accountStorage;
    const promptKey = PRESET_PROMPT_KEY(presetName);
    if (accountStorage && accountStorage.getItem && accountStorage.getItem(promptKey)) {
        return;
    }
    if (accountStorage && accountStorage.setItem) {
        accountStorage.setItem(promptKey, 'true');
    }

    const targetScope = { kind: 'preset', name: presetName };
    try {
        await runEmbedImportFlow({ context, payload, targetScope, t });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[skill-embed-lifecycle] preset embed import failed:', e?.message || e);
    }
}

/**
 * Character delete handler. Removes character-scope skills + clears the
 * "prompted for this avatar" memory so a re-import surfaces the dialog
 * again.
 *
 * @param {object} event - { id, character }
 * @param {object} opts - { context }
 */
export async function onCharacterDeletedCascade(event, { context } = {}) {
    const avatar = event?.character?.avatar;
    if (!avatar || !context) return;
    const accountStorage = context.accountStorage || globalThis.accountStorage;
    if (accountStorage && accountStorage.removeItem) {
        accountStorage.removeItem(CHARACTER_PROMPT_KEY(avatar));
    }
    await cascadeDeleteSkillsInScope({
        context,
        scope: { kind: 'character', characterFile: avatar },
    });
}

/**
 * Preset delete handler. Removes preset-scope skills keyed on the deleted
 * preset's `name` + clears the "prompted for this preset" memory.
 *
 * @param {object} event - { name } (other fields like apiId are accepted but ignored)
 * @param {object} opts - { context }
 */
export async function onPresetDeletedCascade(event, { context } = {}) {
    const name = String(event?.name || '').trim();
    if (!name || !context) return;
    const accountStorage = context.accountStorage || globalThis.accountStorage;
    if (accountStorage && accountStorage.removeItem) {
        accountStorage.removeItem(PRESET_PROMPT_KEY(name));
    }
    await cascadeDeleteSkillsInScope({
        context,
        scope: { kind: 'preset', name },
    });
}

const REGISTERED = Symbol.for('luker_skill_embed_lifecycle_registered');

/**
 * Install all four event handlers on the supplied context's eventSource.
 * Idempotent: subsequent calls are no-ops (guarded by a Symbol on context).
 *
 * @param {object} opts
 * @param {object} opts.context - SillyTavern context (eventSource + eventTypes)
 * @param {(s:string)=>string} [opts.t]
 */
export function registerSkillEmbedLifecycle({ context, t = (s) => s } = {}) {
    if (!context || !context.eventSource || !context.eventTypes) return;
    if (context[REGISTERED]) return;
    Object.defineProperty(context, REGISTERED, { value: true, configurable: true });

    const ev = context.eventSource;
    const et = context.eventTypes;

    if (et.CHAT_CHANGED) {
        ev.on(et.CHAT_CHANGED, () => {
            void checkCharEmbeddedSkills({ context, t });
        });
    }
    if (et.OAI_PRESET_IMPORT_READY) {
        ev.on(et.OAI_PRESET_IMPORT_READY, (event) => {
            void checkPresetEmbeddedSkills(event, { context, t });
        });
    }
    if (et.CHARACTER_DELETED) {
        ev.on(et.CHARACTER_DELETED, (event) => {
            void onCharacterDeletedCascade(event, { context });
        });
    }
    if (et.PRESET_DELETED) {
        ev.on(et.PRESET_DELETED, (event) => {
            void onPresetDeletedCascade(event, { context });
        });
    }
}
