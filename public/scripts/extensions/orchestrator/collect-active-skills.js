/**
 * Collect the union of skills "active" for an orchestrator preset — i.e.
 * every skill any agent in the profile can see once the preset is loaded.
 *
 * Used by the export flow to answer:
 *
 *   "When a user exports this orchestrator preset, which skills should
 *    travel with it so an importer can run it standalone?"
 *
 * Runtime skill visibility is layered (global → oai-preset → orch-preset,
 * plus character which is intentionally excluded here — character-scope
 * skills belong to the character card, not to the orchestrator preset).
 * Each agent then filters its layered view via `skills.visible / deny`.
 * `resolveAgentVisibleSkills` already implements this layering; this
 * module just walks the profile's agent surface and unions the results.
 *
 * Character scope is deliberately omitted from `runtimeContext` so
 * character-scope skills never leak into an orchestrator-preset export.
 * They stay on the character card and export with it via the character
 * card export path.
 */

import { resolveAgentVisibleSkills, invalidateSkillInventory } from './skill-resolution.js';

/**
 * Enumerate every per-agent config inside a portable orchestrator payload
 * along with the runtime-context bits the resolver needs. Returns
 * `[{ agentConfig, presetName }]` — `presetName` is the chat-completion
 * preset the agent is bound to (used to pick up preset-scope skills), or
 * '' when the agent doesn't route through a specific one.
 *
 * @param {string} mode - orch execution mode
 * @param {object} profile - the sanitized profile from buildPortablePayloadForMode
 * @returns {Array<{agentConfig: object, presetName: string}>}
 */
function enumerateAgents(mode, profile) {
    if (!profile || typeof profile !== 'object') return [];
    const out = [];

    const pushAgent = (agentConfig, presetName) => {
        if (!agentConfig || typeof agentConfig !== 'object') return;
        out.push({ agentConfig, presetName: String(presetName || '').trim() });
    };

    if (mode === 'director') {
        // Director profile shape: { mainAgent, subAgents:[], skills, ... }
        pushAgent(profile.mainAgent, profile.mainAgent?.promptPresetName);
        if (Array.isArray(profile.subAgents)) {
            for (const a of profile.subAgents) {
                pushAgent(a, a?.promptPresetName);
            }
        }
        return out;
    }

    if (mode === 'agenda') {
        // Agenda profile shape: { planner, agents:{id: preset}, finalAgentId, ... }
        // The planner itself is an agent that runs and can consult skills.
        pushAgent(profile.planner, profile.planner?.promptPresetName);
        if (profile.agents && typeof profile.agents === 'object') {
            for (const id of Object.keys(profile.agents)) {
                const agent = profile.agents[id];
                pushAgent(agent, agent?.promptPresetName);
            }
        }
        return out;
    }

    if (mode === 'loop') {
        // Loop is single-agent; the profile itself IS the agent config
        // (mode-level skills live on `profile.skills`).
        pushAgent(profile, profile?.promptPresetName);
        return out;
    }

    // spec: { spec: {stages:[{nodes:[{preset, skills?}]}], skills}, presets: {name: {promptPresetName, skills?}} }
    // Each node references a preset by name; the preset carries the
    // promptPresetName and the resolver sees the (node.skills ?? preset.skills)
    // via agent config. We fold both into one synthetic agent per node.
    const specBlock = profile?.spec && typeof profile.spec === 'object' ? profile.spec : null;
    const presetMap = profile?.presets && typeof profile.presets === 'object' ? profile.presets : {};
    if (specBlock && Array.isArray(specBlock.stages)) {
        for (const stage of specBlock.stages) {
            if (!Array.isArray(stage?.nodes)) continue;
            for (const node of stage.nodes) {
                if (!node) continue;
                const presetName = typeof node === 'string' ? node : String(node?.preset || node?.id || '').trim();
                const presetConfig = presetName ? presetMap[presetName] : null;
                // Synthesize an agentConfig: node.skills wins over preset.skills;
                // promptPresetName comes from the preset entry.
                const nodeSkills = (typeof node === 'object' && node?.skills) || null;
                const presetSkills = presetConfig?.skills || null;
                const skills = nodeSkills || presetSkills || undefined;
                const agentConfig = skills ? { skills } : {};
                pushAgent(agentConfig, presetConfig?.promptPresetName);
            }
        }
    }
    // Also include each preset entry itself as an agent — the resolver
    // needs to see its promptPresetName so preset-scope skills that are
    // wildcard-visible at the mode level are picked up even when no node
    // references the preset directly.
    for (const key of Object.keys(presetMap)) {
        const p = presetMap[key];
        pushAgent(p, p?.promptPresetName);
    }
    return out;
}

/**
 * Resolve the full set of skills any agent inside this orchestrator preset
 * can see, unioned across all agent positions and de-duplicated by
 * (scope, name). Returns entries grouped by source scope so the caller
 * can pack each group with the correct source scope.
 *
 * @param {object} payload - the portable orchestrator preset payload
 *   (must have `.mode`, `.name`, `.profile`)
 * @returns {Promise<Map<string, {scope: object, names: string[]}>>}
 *   Map key: `${scope.kind}|${scope.name||''}|${scope.mode||''}|${scope.characterFile||''}`
 *   Map value: `{ scope, names: sorted unique skill names in that scope }`
 */
export async function collectResolvedSkillsForOrchPreset(payload) {
    if (!payload || typeof payload !== 'object') return new Map();
    const mode = String(payload.mode || '').trim();
    const name = String(payload.name || payload.profile?.name || '').trim();
    if (!mode || !name) return new Map();

    const profile = payload.profile || payload;
    const agents = enumerateAgents(mode, profile);

    // Even when the profile has zero explicit agents (fresh spec with
    // empty stages, etc.) we still want mode-level wildcard skills to
    // count. Run the resolver once with agentConfig=null so the mode
    // profile's own visible/deny apply.
    const probeList = [{ agentConfig: null, presetName: '' }, ...agents];

    // Drop cache once so the resolver sees fresh disk state — export is
    // an infrequent operation and staleness would silently omit newly
    // installed skills.
    invalidateSkillInventory();

    const byScope = new Map();
    for (const probe of probeList) {
        const runtimeContext = { orchPreset: { mode, name } };
        if (probe.presetName) runtimeContext.presetName = probe.presetName;
        // NOTE: `characterFile` intentionally omitted — character-scope
        // skills stay on the character card and are not part of the
        // orchestrator preset's "active" set for export purposes.
        let visible;
        try {
            visible = await resolveAgentVisibleSkills({
                modeProfile: profile,
                agentConfig: probe.agentConfig,
                runtimeContext,
            });
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[collect-active-skills] resolver failed:', e?.message || e);
            continue;
        }
        if (!Array.isArray(visible)) continue;
        for (const entry of visible) {
            const scope = entry?.scope;
            const skillName = entry?.name;
            if (!scope || typeof scope !== 'object' || typeof skillName !== 'string' || !skillName) continue;
            // Character-scope entries should not appear (we passed no
            // characterFile) but guard anyway in case a future resolver
            // change surfaces them via a different path.
            if (scope.kind === 'character') continue;
            const key = `${scope.kind}|${scope.name || ''}|${scope.mode || ''}`;
            let bucket = byScope.get(key);
            if (!bucket) {
                bucket = { scope: { ...scope }, names: new Set() };
                byScope.set(key, bucket);
            }
            bucket.names.add(skillName);
        }
    }

    // Freeze Set → sorted array so downstream packing is deterministic.
    const out = new Map();
    for (const [key, { scope, names }] of byScope) {
        out.set(key, { scope, names: [...names].sort() });
    }
    return out;
}
