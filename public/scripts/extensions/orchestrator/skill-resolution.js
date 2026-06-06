/**
 * Skill-resolution helpers for orchestrator runtimes.
 *
 * Bridges Luker's skill inventory (`skillsApi.list`) with the orchestrator's
 * per-agent visibility model. Each orchestrator mode profile (director / loop /
 * spec / agenda) plus each per-agent config (sub-agent, spec node, agenda
 * worker, loop's single agent) carries an optional `skills: { visible, deny }`
 * field that filters which installed skills the agent sees.
 *
 * Three responsibilities:
 *
 *   - `ensureSkillsFieldShape(obj, opts)` — normalize the on-disk shape of the
 *     `skills` field at sanitizer time. Mode-level: defaults to
 *     `{ visible: ['*'], deny: [] }` so all installed skills are visible.
 *     Agent-level (`isAgent: true`): leaves the field undefined when absent
 *     so the resolver knows to "inherit mode default"; normalizes a partial
 *     shape if present.
 *
 *   - `resolveAgentVisibleSkills({ modeProfile, agentConfig, runtimeContext })`
 *     — load the inventory (with brief in-memory cache), merge the three
 *     scope layers (global → preset → character, last-wins), then filter by
 *     the effective visible/deny lists. Agent-level visible starting with
 *     `"+"` inherits the mode default and appends; otherwise it replaces.
 *     Returns the SkillIndexEntry[] the agent can see.
 *
 *   - `buildAvailableSkillsBlock(visibleSkills)` — render the
 *     `<available_skills>` system-message block injected into agent task
 *     messages so the model knows which skills exist + their descriptions.
 *
 *   - `invalidateSkillInventory()` — drop the cache. Called on mode switch
 *     and after any skill mutation that arrives from outside this module.
 *
 * The cache is module-global and short-lived (TTL ~5s) — long enough to amortize
 * the four resolver calls a single director turn typically makes (main agent +
 * up to N sub-agents dispatched in the same round) but short enough that user-
 * driven changes (install / delete via UI) become visible without a manual
 * refresh.
 */

const skillsApi = SillyTavern.getContext().skills;

let cachedInventory = null;
let cacheStamp = 0;
const CACHE_TTL_MS = 5000;

/**
 * Normalize the `skills` field on a mode profile or per-agent config in place.
 *
 * Mode-level (default): inserts `{ visible: ['*'], deny: [] }` when absent.
 * Agent-level (`opts.isAgent === true`): leaves `obj.skills` undefined when
 * absent so the resolver knows to fall back to the mode default; only
 * canonicalizes the shape if the caller already provided a partial object.
 *
 * The mode/agent distinction matters because the `+` inheritance semantics
 * are anchored on the mode profile — overwriting an undefined agent field
 * with the mode default would erase the "inherit" signal.
 *
 * @param {object} obj
 * @param {{ isAgent?: boolean }} [opts]
 */
export function ensureSkillsFieldShape(obj, { isAgent = false } = {}) {
    if (!obj || typeof obj !== 'object') return;
    if (isAgent) {
        if (obj.skills && typeof obj.skills === 'object') {
            if (!Array.isArray(obj.skills.visible)) obj.skills.visible = [];
            if (!Array.isArray(obj.skills.deny)) obj.skills.deny = [];
        }
        return;
    }
    if (!obj.skills || typeof obj.skills !== 'object') {
        obj.skills = { visible: ['*'], deny: [] };
        return;
    }
    if (!Array.isArray(obj.skills.visible)) obj.skills.visible = ['*'];
    if (!Array.isArray(obj.skills.deny)) obj.skills.deny = [];
}

/**
 * Resolve the list of skills visible to an agent.
 *
 * Pipeline:
 *   1. Load (and briefly cache) the full inventory via `skillsApi.list({ scope: 'all' })`.
 *      Network/transport failure collapses to an empty inventory so the
 *      orchestrator never fails closed for a transient REST error — the agent
 *      sees no skills, not a crash.
 *   2. Merge the three scope layers (global → preset → character) using a
 *      Map keyed by skill name. Character-scope wins by virtue of arriving
 *      last in the merge order. This mirrors the precedence the agent-tools
 *      fallback path uses in Unit 5 (scope priority: character > preset > global).
 *   3. Compute effective visible/deny by combining mode and agent lists.
 *      Agent visible starting with `'+'` means "inherit mode default and
 *      append the rest"; otherwise the agent list replaces the mode default
 *      entirely. Deny lists always union (agent deny adds to mode deny).
 *   4. Filter the merged inventory by visible (wildcard `*` matches all)
 *      and deny.
 *
 * @param {object} args
 * @param {object} args.modeProfile - orchestrator mode profile (director, loop, etc.)
 * @param {object|null} args.agentConfig - per-agent config or null for mode-only
 * @param {object} args.runtimeContext - { presetName, characterFile }
 * @returns {Promise<Array>} visible skills (SkillIndexEntry shape)
 */
export async function resolveAgentVisibleSkills({ modeProfile, agentConfig, runtimeContext }) {
    const now = Date.now();
    if (!cachedInventory || (now - cacheStamp) > CACHE_TTL_MS) {
        try {
            cachedInventory = await skillsApi.list({ scope: 'all' });
            cacheStamp = now;
        } catch (e) {
            console.warn('[skill-resolution] failed to load skill inventory:', e?.message || e);
            cachedInventory = [];
            cacheStamp = now;
        }
    }
    const inventoryRaw = Array.isArray(cachedInventory) ? cachedInventory : [];

    // Physical scope merge (later-wins). Building a Map keyed by name gives
    // O(N) merge and natural collision handling — a character-scope skill
    // with the same name as a preset-scope one supersedes it for this turn.
    const merged = new Map();
    for (const e of inventoryRaw) {
        if (e?.scope?.kind === 'global') merged.set(e.name, e);
    }
    if (runtimeContext?.presetName) {
        for (const e of inventoryRaw) {
            if (e?.scope?.kind === 'preset'
                && e.scope.name === runtimeContext.presetName) {
                merged.set(e.name, e);
            }
        }
    }
    if (runtimeContext?.characterFile) {
        for (const e of inventoryRaw) {
            if (e?.scope?.kind === 'character'
                && e.scope.characterFile === runtimeContext.characterFile) {
                merged.set(e.name, e);
            }
        }
    }
    const inventory = Array.from(merged.values());

    // Normalize the mode profile so the lookups below always see arrays.
    // We mutate the input here rather than working on a clone — sanitizer
    // shape is idempotent and callers benefit from the canonical fields.
    ensureSkillsFieldShape(modeProfile);
    const modeVisible = Array.isArray(modeProfile?.skills?.visible)
        ? modeProfile.skills.visible : ['*'];
    const modeDeny = Array.isArray(modeProfile?.skills?.deny)
        ? modeProfile.skills.deny : [];
    const agentVisible = Array.isArray(agentConfig?.skills?.visible)
        ? agentConfig.skills.visible : null;
    const agentDeny = Array.isArray(agentConfig?.skills?.deny)
        ? agentConfig.skills.deny : [];

    let effectiveVisible;
    if (!agentVisible || agentVisible.length === 0) {
        effectiveVisible = modeVisible;
    } else if (agentVisible[0] === '+') {
        effectiveVisible = [...modeVisible, ...agentVisible.slice(1)];
    } else {
        effectiveVisible = agentVisible;
    }
    const effectiveDeny = [...new Set([...modeDeny, ...agentDeny])];

    const visibleSet = new Set(effectiveVisible);
    const denySet = new Set(effectiveDeny);
    const wildcard = visibleSet.has('*');

    return inventory.filter(s =>
        s && typeof s.name === 'string'
        && (wildcard || visibleSet.has(s.name))
        && !denySet.has(s.name),
    );
}

/**
 * Build the `<available_skills>` system-message block appended to an
 * agent's task messages.
 *
 * Empty / null input collapses to an empty string so callers can do
 * `systemPrompt + (block ? '\n\n' + block : '')` without conditional guards.
 *
 * @param {Array} visibleSkills
 * @returns {string}
 */
export function buildAvailableSkillsBlock(visibleSkills) {
    if (!Array.isArray(visibleSkills) || visibleSkills.length === 0) return '';
    const lines = visibleSkills
        .filter(s => s && typeof s.name === 'string')
        .map(s => `- ${s.name}: ${String(s.description || '')}`)
        .join('\n');
    if (!lines) return '';
    return [
        '<available_skills>',
        lines,
        '</available_skills>',
        '',
        '(Use skill_read to consult specific content; skill_search to grep within a skill.)',
    ].join('\n');
}

/**
 * Drop the inventory cache. Call on mode switch and after any skill mutation
 * (install / delete / rename / move) that the resolver did not initiate.
 */
export function invalidateSkillInventory() {
    cachedInventory = null;
    cacheStamp = 0;
}

/**
 * Build a `runtimeContext` bag from a SillyTavern context + agent profile.
 *
 * The resolver uses two fields:
 *   - `presetName`  — the chat-completion preset name (e.g. 'rp4'); matched
 *     against `e.scope.name` for preset-scope skills
 *   - `characterFile` — the active character's avatar filename (e.g. 'alice.png')
 *
 * Each is optional; missing values just skip the corresponding scope layer.
 * Callers that want only the character context (no preset routing) can pass
 * a `null` agentProfile.
 *
 * @param {object|null} sillyTavernContext - typically `getContext()`
 * @param {object|null} agentProfile - agent config with `promptPresetName`
 * @returns {{ presetName?: string, characterFile?: string }}
 */
export function buildSkillRuntimeContext(sillyTavernContext, agentProfile = null) {
    const ctx = {};
    // Character: read avatar filename from the live characters array if available.
    // `characterId` is the index; `characters[characterId].avatar` is the filename
    // we expose as skill scope id. Defensive fallback for partial contexts.
    try {
        const cid = sillyTavernContext?.characterId;
        if (cid !== undefined && cid !== null && Array.isArray(sillyTavernContext?.characters)) {
            const avatar = sillyTavernContext.characters[cid]?.avatar;
            if (typeof avatar === 'string' && avatar.length > 0) {
                ctx.characterFile = avatar;
            }
        }
    } catch (_) { /* tolerate sparse context shapes */ }

    // Preset: the agent's per-agent routing override is the source of truth
    // when set; otherwise the orchestrator's global LLM-node preset names
    // apply (carried in `sillyTavernContext` indirectly via settings).
    // Callers handle the fallback chain themselves; here we just lift what
    // the agent profile explicitly declares.
    //
    // The skill-scope `preset` shape is `{kind:'preset', name}` — the
    // connection profile is intentionally NOT part of the key, so a
    // preset-scope skill travels with the preset regardless of which
    // connection profile happens to be routing the request.
    if (agentProfile && typeof agentProfile === 'object') {
        const promptPresetName = String(agentProfile.promptPresetName || '').trim();
        if (promptPresetName) ctx.presetName = promptPresetName;
    }

    return ctx;
}
