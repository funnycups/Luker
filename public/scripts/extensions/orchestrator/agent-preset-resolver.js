// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Pure card-first preset-name resolution helper for the orchestrator.
 *
 * Extracted so director-runtime / director-tools / agent-resolution can
 * share one implementation of "look up an explicit preset name against
 * the active card first, then fall back to a settings-configured
 * default". Prior to this module those three sites carried three
 * different copies (director's two copies did a raw string fallback
 * with NO card lookup, silently ignoring embedded presets — the
 * orchestrator's card-first binding rule was violated for director
 * agents).
 *
 * The helper is intentionally kept free of `st-context.js` /
 * `/scripts/character/presets.js` imports so it stays Jest-clean.
 * Consumers inject `resolveByName` (normally
 * `Luker.getContext().character.presets.resolveByName`) and the target
 * `character` themselves; adapter/executor lift pattern per
 * feedback_adapter_executor_lift_pattern.
 *
 * Return shape mirrors `resolveCharacterBoundPresetByName`:
 *   - Explicit name found on card              → `{name, preset, origin: 'card'}`
 *   - Explicit name found in local global      → `{name, preset, origin: 'global'}`
 *   - Explicit name missing everywhere         → `{name: explicit, preset: null, origin: null}`
 *     (name preserved for logging / display; `origin: null` marks "unknown"
 *     so downstream classifiers — e.g. the Save-to-Character unembedded-
 *     preset detector — do not misread the reference as a global preset.)
 *   - No explicit, fallback resolves            → same shape, using fallback
 *   - Neither explicit nor fallback given       → `null`
 *
 * @param {object} params
 * @param {string|null|undefined} params.explicitName
 *        Name pulled from the agent's own `apiPresetName` /
 *        `promptPresetName` field. Falsy values are treated as absent.
 * @param {string|null|undefined} params.fallbackName
 *        Name pulled from `settings.llmNodeApiPresetName` /
 *        `settings.llmNodePresetName`. Falsy values are treated as absent.
 * @param {object|null|undefined} params.character
 *        The active character object (proxy-wrapped
 *        `ctx.characters[ctx.characterId]`). When null the card branch is
 *        skipped and only the global branch of `resolveByName` can hit.
 * @param {(character: object, name: string) => ({origin: 'card'|'global', name: string, preset: object}|null)|null|undefined} params.resolveByName
 *        Card-first resolver, normally
 *        `ctx.character.presets.resolveByName`. Injected rather than
 *        imported so the module stays Jest-clean.
 * @returns {{name: string, preset: object|null, origin: 'card'|'global'|null} | null}
 */
export function resolveCardFirstPresetName({
    explicitName,
    fallbackName,
    character,
    resolveByName,
} = {}) {
    const explicit = String(explicitName || '').trim();
    const fallback = String(fallbackName || '').trim();

    const tryLookup = (name) => {
        if (!name) return null;
        // resolveByName is expected to be card-first-then-global. When it
        // is missing (bootstrap edge / test wiring gap) we cannot look
        // anything up; return `{origin: null}` so callers still get the
        // raw name for logging while explicitly marking it as unresolved.
        if (typeof resolveByName !== 'function' || !character) {
            return { name, preset: null, origin: null };
        }
        const hit = resolveByName(character, name);
        if (hit) {
            return {
                name: hit.name,
                preset: hit.preset ?? null,
                origin: hit.origin === 'card' ? 'card' : 'global',
            };
        }
        return { name, preset: null, origin: null };
    };

    if (explicit) return tryLookup(explicit);
    if (fallback) return tryLookup(fallback);
    return null;
}
