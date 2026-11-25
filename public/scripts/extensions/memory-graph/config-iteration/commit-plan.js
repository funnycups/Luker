// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Commit planning for the Memory Graph configuration studio.
 *
 * The working document is `{ schema, settings }`. A commit has to land in
 * up to two stores, and the settings half is stored SPARSELY on a
 * character card (only the keys that differ from the global layer), so a
 * raw before/after diff is not enough:
 *
 *   - A key whose next value equals the inherited baseline must be
 *     REMOVED from the character override, not written — writing it would
 *     freeze a redundant copy of the global value onto the card.
 *   - A key whose next value differs from the baseline is written as-is.
 *
 * `planConfigCommit` derives that plan; `applyConfigPlan` executes it.
 *
 * Fail-closed contract for `applyConfigPlan`: when a character write is
 * rejected (the persist helper returns false) the plan THROWS. There is no
 * fall-through to the global store — the historical fall-through let a
 * failed override write silently mutate global state, which is exactly the
 * corruption the sparse-override model exists to prevent. The bus catches
 * the throw and parks the entry in `conflict`.
 *
 * Write gating: a half of the plan that did not change is not written at
 * all. Writing an unchanged schema onto a card that has no schema override
 * would CREATE an override the user never asked for (the working schema
 * starts as a fork of the global one), and patching a character blob with
 * an empty `{ set, unset }` is a pointless card write.
 */

import { CONFIG_FIELDS } from './fields.js';

/**
 * Derive the commit plan for a `{ schema, settings }` document pair.
 *
 * Only the registered settings keys participate; foreign keys on either
 * side are ignored. Both schema arrays are expected to be already
 * normalized (the studio normalizes on load and on every sandbox diff), so
 * the comparison takes them as given.
 *
 * @param {object} params
 * @param {{schema?: any[], settings?: object}} params.before  live config at propose/commit time
 * @param {{schema?: any[], settings?: object}} params.next   config the proposal commits
 * @param {'character'|'global'} params.scope                 storage scope the plan runs under
 * @param {object} params.inheritedSettings                  the layer an `unset` restores:
 *        the global settings view in character scope, the code defaults in
 *        global scope
 * @returns {{schemaChanged: boolean, schema: any[], changedKeys: string[],
 *            set: Object<string, *>, unset: string[], hasChanges: boolean}}
 */
export function planConfigCommit({ before, next, scope, inheritedSettings } = {}) {
    const beforeSettings = before?.settings && typeof before.settings === 'object' && !Array.isArray(before.settings)
        ? before.settings
        : {};
    const nextSettings = next?.settings && typeof next.settings === 'object' && !Array.isArray(next.settings)
        ? next.settings
        : {};
    const inherited = inheritedSettings && typeof inheritedSettings === 'object' && !Array.isArray(inheritedSettings)
        ? inheritedSettings
        : {};

    const set = {};
    const unset = [];
    const changedKeys = [];
    for (const def of Object.values(CONFIG_FIELDS)) {
        const key = def.key;
        if (Object.is(nextSettings[key], beforeSettings[key])) continue;
        changedKeys.push(key);
        if (Object.is(nextSettings[key], inherited[key])) {
            unset.push(key);
        } else {
            set[key] = nextSettings[key];
        }
    }

    let schemaChanged = false;
    try {
        schemaChanged = JSON.stringify(before?.schema ?? null) !== JSON.stringify(next?.schema ?? null);
    } catch {
        schemaChanged = true;
    }

    return {
        schemaChanged,
        schema: next?.schema,
        changedKeys,
        set,
        unset,
        hasChanges: schemaChanged || changedKeys.length > 0,
    };
}

/**
 * Execute a commit plan. See the module header for the fail-closed and
 * write-gating contracts.
 *
 * @param {{schemaChanged: boolean, schema: any[], set: object, unset: string[]}} plan
 *        output of {@link planConfigCommit}
 * @param {object} opts
 * @param {'character'|'global'} opts.scope
 * @param {object} opts.globalSettings      the memory-graph settings root; the
 *        global branch mutates it in place
 * @param {(schema: any[]) => Promise<boolean>} opts.persistCharacterSchema
 * @param {(patch: {set: object, unset: string[]}) => Promise<boolean>} opts.persistCharacterSettings
 * @param {() => Promise<{ok: boolean, status: string, error?: string, reason?: string}>} opts.saveGlobalSettings
 * @returns {Promise<void>} throws when persistence is not acknowledged
 */
export async function applyConfigPlan(plan, opts) {
    const {
        scope,
        globalSettings,
        persistCharacterSchema,
        persistCharacterSettings,
        saveGlobalSettings,
    } = opts || {};

    if (scope === 'character') {
        if (plan.schemaChanged) {
            const schemaOk = await persistCharacterSchema(plan.schema);
            if (schemaOk !== true) {
                throw new Error('applyConfigPlan: character schema override write rejected');
            }
        }
        const hasSettingsPatch = Object.keys(plan.set || {}).length > 0 || (plan.unset || []).length > 0;
        if (hasSettingsPatch) {
            const settingsOk = await persistCharacterSettings({ set: plan.set, unset: plan.unset });
            if (settingsOk !== true) {
                throw new Error('applyConfigPlan: character settings override write rejected');
            }
        }
        return;
    }

    const keys = [
        ...(plan.schemaChanged ? ['nodeTypeSchema'] : []),
        ...Object.keys(plan.set || {}),
        ...(plan.unset || []),
    ];
    const previous = new Map(keys.map(key => [key, { present: Object.hasOwn(globalSettings, key), value: globalSettings[key] }]));
    if (plan.schemaChanged) {
        globalSettings.nodeTypeSchema = plan.schema;
    }
    for (const [key, value] of Object.entries(plan.set || {})) {
        globalSettings[key] = value;
    }
    for (const key of plan.unset || []) {
        delete globalSettings[key];
    }
    const written = new Map(keys.map(key => [key, { present: Object.hasOwn(globalSettings, key), value: JSON.stringify(globalSettings[key]) }]));
    try {
        const outcome = await saveGlobalSettings();
        if (outcome?.ok !== true || outcome.status !== 'saved') {
            throw new Error(`applyConfigPlan: global settings write rejected: ${outcome?.error || outcome?.reason || outcome?.status}`);
        }
    } catch (error) {
        for (const key of keys) {
            const attempted = written.get(key);
            if (Object.hasOwn(globalSettings, key) !== attempted.present || JSON.stringify(globalSettings[key]) !== attempted.value) continue;
            const before = previous.get(key);
            if (before.present) globalSettings[key] = before.value;
            else delete globalSettings[key];
        }
        throw error;
    }
}
