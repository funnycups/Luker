/**
 * Agent-visible skill tools (skill_list / skill_read / skill_search).
 *
 * These are registered globally on Luker's ToolManager at app boot so any
 * function-call-capable agent can use them. Visibility is gated by an
 * optional `agentContext.__visibleSkillsForAgent` that the orchestrator
 * sets at dispatch time (Unit 6+) — when absent, the tools fall back to
 * the global skill list so non-orchestrator callers (direct testing,
 * other consumers) still work.
 *
 * The ToolManager today invokes `action(parameters)` with a single arg.
 * The second `agentContext` parameter is honoured when present (e.g. an
 * orchestrator dispatcher calling `action(args, ctx)` directly) and
 * silently ignored otherwise.
 */

import { skillsApi } from './api.js';

/**
 * Resolve the skill an agent is referring to by name.
 * Prefers `agentContext.__visibleSkillsForAgent` (set by orchestrator
 * dispatch in Unit 6+). Falls back to the global skill list if absent.
 *
 * @param {string} name
 * @param {object} [agentContext]
 * @returns {Promise<object>} skill entry with at least { name, scope }
 */
async function resolveSkill(name, agentContext) {
    const visible = agentContext?.__visibleSkillsForAgent;
    if (Array.isArray(visible)) {
        const found = visible.find((s) => s.name === name);
        if (found) return found;
        throw new Error(`skill not visible to this agent: ${name}`);
    }
    // Fallback path (no orchestrator context — direct testing or non-orchestrator caller).
    // TODO(unit-7): integration smoke must verify that an agent dispatched by the
    //   orchestrator without `__visibleSkillsForAgent` on its agentContext cannot
    //   resolve skills outside its declared visible set. This fallback is
    //   intentionally fail-open so direct/test callers keep working; orchestrator
    //   dispatch MUST set `__visibleSkillsForAgent` for the gate to take effect.
    const all = await skillsApi.list({ scope: 'all' });
    // Apply later-wins precedence (character > preset > global) so name
    // collisions resolve identically to the orchestrator runtime's getVisible
    // (spec §5). Sort descending by priority then pick the first match.
    const ordered = [...all].sort((a, b) => scopePriority(b.scope) - scopePriority(a.scope));
    const fallback = ordered.find((s) => s.name === name);
    if (!fallback) throw new Error(`skill not found: ${name}`);
    return fallback;
}

/**
 * Priority for later-wins precedence. Higher number wins on name collision.
 * Mirrors spec §5: character overrides preset which overrides global.
 *
 * @param {object} [scope]
 * @returns {number}
 */
function scopePriority(scope) {
    if (!scope) return 0;
    if (scope.kind === 'character') return 3;
    if (scope.kind === 'preset') return 2;
    if (scope.kind === 'global') return 1;
    return 0;
}

/**
 * Register the three agent-visible skill tools on a tool registry.
 *
 * Silently no-ops if `toolManager` is missing or lacks
 * `registerFunctionTool` — this keeps boot resilient when the host
 * doesn't expose a ToolManager (e.g. a stripped-down embedding).
 *
 * @param {object} toolManager
 */
export function registerSkillAgentTools(toolManager) {
    if (!toolManager || typeof toolManager.registerFunctionTool !== 'function') {
        console.warn('[skills] ToolManager not available; skipping agent tool registration');
        return;
    }

    toolManager.registerFunctionTool({
        name: 'skill_list',
        displayName: 'List skills',
        description: 'List skills available to the current agent. Returns name + description for each. Use this before skill_read to discover what knowledge is accessible.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Optional substring to filter name or description (case-insensitive).',
                },
            },
        },
        action: async (args, agentContext) => {
            const visible = agentContext?.__visibleSkillsForAgent
                || (await skillsApi.list({ scope: 'all' }));
            const q = args && args.query ? String(args.query).toLowerCase() : null;
            const filtered = q
                ? visible.filter((s) =>
                    s.name.toLowerCase().includes(q)
                    || String(s.description || '').toLowerCase().includes(q))
                : visible;
            return filtered.map((s) => ({
                name: s.name,
                description: s.description,
                tags: (s.metadata && s.metadata.tags) || [],
            }));
        },
        formatMessage: (args) => `List skills${args?.query ? ` (filter: ${args.query})` : ''}`,
    });

    toolManager.registerFunctionTool({
        name: 'skill_read',
        displayName: 'Read skill file',
        description: 'Read a file inside a visible skill. Default path is SKILL.md. Use offset/limit for line ranges.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Skill name' },
                path: { type: 'string', description: 'File path within the skill (default SKILL.md)' },
                offset: { type: 'integer', description: '1-based start line' },
                limit: { type: 'integer', description: 'Number of lines to read' },
            },
            required: ['name'],
        },
        action: async (args, agentContext) => {
            const target = await resolveSkill(args.name, agentContext);
            return await skillsApi.readFile({
                scope: target.scope,
                name: args.name,
                path: args.path,
                offset: args.offset,
                limit: args.limit,
            });
        },
        formatMessage: (args) => `Read skill ${args.name}${args.path ? `:${args.path}` : ''}`,
    });

    toolManager.registerFunctionTool({
        name: 'skill_search',
        displayName: 'Search within skill',
        description: 'Search for a substring inside a single visible skill\'s files. Returns matching snippets with refs.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Skill name' },
                query: { type: 'string', description: 'Search substring (case-insensitive)' },
                path: { type: 'string', description: 'Optional file path (default SKILL.md)' },
                limit: { type: 'integer', description: 'Max hits' },
                contextLines: { type: 'integer', description: 'Context lines around each hit' },
            },
            required: ['name', 'query'],
        },
        action: async (args, agentContext) => {
            const target = await resolveSkill(args.name, agentContext);
            return await skillsApi.search({
                scope: target.scope,
                name: args.name,
                query: args.query,
                path: args.path,
                limit: args.limit,
                contextLines: args.contextLines,
            });
        },
        formatMessage: (args) => `Search skill ${args.name}: "${args.query}"`,
    });
}
