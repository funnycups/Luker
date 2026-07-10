// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Collect all chat-completion preset names referenced by an orchestrator
 * profile that are NOT currently embedded in the active character card.
 *
 * Driven by the Save To Character Override summary popup — the classifier
 * consults the injected `resolveByName` for each referenced name:
 *
 *   - `origin: 'card'` → the name is already embedded on the card; skip.
 *   - `origin: 'global'` → the name exists as a local global preset only;
 *     eligible for the "embed alongside the profile" prompt so recipients
 *     who import the card get the preset too.
 *   - `null` → the name is unknown to both card and global; skip (runtime
 *     falls back to `settings.llmNodePresetName`).
 *
 * Deduplicates by preset name — the same preset referenced from multiple
 * agent slots is surfaced once, with `usages` listing every referring
 * site so the popup can describe *where* the name is used.
 *
 * Scope: covers `loop`, `agenda`, and `director` mode profiles.  Spec
 * mode's per-node preset refs live inside a nested `presets` map that
 * is edited via iter-studio and is out of scope here; the helper returns
 * an empty list for `mode: 'spec'`.
 *
 * @param {object|null} profile   Editor draft (or sanitized profile);
 *                                sanitizers keep preset names opaque
 *                                (opaque-string contract), so either
 *                                shape works.
 * @param {object|null} character
 * @param {(character: object, name: string) => ({origin: 'card'|'global', name: string, preset: object}|null)} resolveByName
 *   Injected resolver, normally `ctx.character.presets.resolveByName`.
 *   Injection is required (rather than imported straight from
 *   `/scripts/character/presets.js`) because that module transitively
 *   pulls `st-context.js` → `RossAscends-mods.js` → Bowser, which is
 *   absent from the Jest lib bundle and would break every orchestrator
 *   suite that transitively imports this file via main.js.
 * @returns {Array<{name: string, usages: string[]}>}
 */
export function collectUnembeddedPresets(profile, character, resolveByName) {
    if (!character || typeof resolveByName !== 'function') return [];

    /** @type {Map<string, Set<string>>} */
    const usagesByName = new Map();

    const addUsage = (name, usage) => {
        const trimmed = String(name || '').trim();
        if (!trimmed) return;
        const resolved = resolveByName(character, trimmed);
        if (!resolved) return;                    // unknown → runtime fallback
        if (resolved.origin === 'card') return;   // already embedded
        if (resolved.origin !== 'global') return; // defensive: only global refs are prompt-able
        if (!usagesByName.has(trimmed)) usagesByName.set(trimmed, new Set());
        usagesByName.get(trimmed).add(usage);
    };

    const mode = String(profile?.mode || '').trim();
    if (mode === 'loop') {
        addUsage(profile.promptPresetName, 'loop root prompt preset');
        addUsage(profile.apiPresetName, 'loop root API preset');
    } else if (mode === 'agenda') {
        const planner = profile.planner || {};
        addUsage(planner.plannerPromptPresetName, 'planner prompt preset');
        addUsage(planner.plannerApiPresetName, 'planner API preset');
        const agents = profile.agents && typeof profile.agents === 'object' ? profile.agents : {};
        for (const [id, agent] of Object.entries(agents)) {
            const label = String(agent?.name || id || '').trim() || id;
            addUsage(agent?.promptPresetName, `agent "${label}" prompt preset`);
            addUsage(agent?.apiPresetName, `agent "${label}" API preset`);
        }
    } else if (mode === 'director') {
        const main = profile.mainAgent || {};
        addUsage(main.promptPresetName, 'director main prompt preset');
        addUsage(main.apiPresetName, 'director main API preset');
        const subs = Array.isArray(profile.subAgents) ? profile.subAgents : [];
        for (const sub of subs) {
            const label = String(sub?.name || sub?.id || '').trim() || 'unnamed sub-agent';
            addUsage(sub?.promptPresetName, `sub-agent "${label}" prompt preset`);
            addUsage(sub?.apiPresetName, `sub-agent "${label}" API preset`);
        }
    }
    // spec mode: out of scope (see JSDoc above).

    return Array.from(usagesByName.entries()).map(([name, set]) => ({
        name,
        usages: Array.from(set),
    }));
}
