/**
 * Orchestrator-side registration of the three agent-visible skill tools
 * (`skill_list`, `skill_read`, `skill_search`) via `registerOrchestrationTool`.
 *
 * Why this exists alongside `public/scripts/skills/agent-tools.js`:
 *
 *   - `agent-tools.js` registers the same three tools on the SillyTavern
 *     `ToolManager`. That registry is what generic ST function-call agents
 *     (outside the orchestrator) walk to dispatch tool calls.
 *   - The orchestrator's `executeLoopTool` (loop-tools.js) does NOT consult
 *     `ToolManager.tools` — it walks three registries in order:
 *       Layer-3 `ctx.__customToolRegistry` (per-run profile customs)
 *       Layer-1 `REGISTRY` (builtins registered via `registerTool`)
 *       Layer-2 `EXTENSION_REGISTRY` (registered via `registerOrchestrationTool`)
 *
 * Without registration here, the catalog block injected into agent task
 * messages would advertise `skill_read` / `skill_search` but the
 * orchestrator's dispatcher would fail with `NOT_IMPLEMENTED` when an agent
 * called them. Registering via `registerOrchestrationTool` lands them in
 * `EXTENSION_REGISTRY`, completing the dispatch wiring.
 *
 * The execs lift their visibility set from `ctx.__visibleSkillsForAgent`
 * (set by each runtime's dispatch path — director/loop/spec/agenda). When
 * the runtime didn't populate it (e.g. some non-orchestrator caller routed
 * through `executeLoopTool` directly), the resolvers fall back to a global
 * list with character > preset > global precedence so the call still
 * returns sensible results instead of crashing.
 */

import {
    registerOrchestrationTool,
    unregisterOrchestrationTool,
} from './register-custom-tool.js';
import { gatherGrepMatches } from './grep-tool.js';
const skillsApi = Luker.getContext().skills;

const SKILL_TOOL_NAMES = ['skill_list', 'skill_read', 'skill_search'];

/**
 * Priority for later-wins precedence in the no-context fallback path.
 * Mirrors `agent-tools.js#scopePriority` so non-orchestrator callers
 * resolve skill name collisions identically to ToolManager-routed agents.
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
 * Resolve the skill an agent is referring to by name from the dispatch
 * context. Prefers `ctx.__visibleSkillsForAgent` (set by each runtime's
 * dispatch path); falls back to a global list with character > preset >
 * global precedence so direct callers (tests, non-orchestrator dispatch)
 * still resolve sensibly.
 *
 * @param {string} name
 * @param {object} [ctx]
 * @returns {Promise<object>} skill entry with at least { name, scope }
 */
async function resolveSkillFromCtx(name, ctx) {
    const visible = ctx?.__visibleSkillsForAgent;
    if (Array.isArray(visible)) {
        const found = visible.find((s) => s.name === name);
        if (found) return found;
        throw new Error(`skill not visible to this agent: ${name}`);
    }
    const all = await skillsApi.list({ scope: 'all' });
    const ordered = [...all].sort((a, b) => scopePriority(b.scope) - scopePriority(a.scope));
    const fallback = ordered.find((s) => s.name === name);
    if (!fallback) throw new Error(`skill not found: ${name}`);
    return fallback;
}

/**
 * Register the three skill tools on the orchestrator's Layer-2 extension
 * registry so `executeLoopTool` can dispatch them. Safe to call more than
 * once — `registerOrchestrationTool` overwrites in place, so a re-register
 * just refreshes the entries.
 */
export function registerSkillOrchestrationTools() {
    registerOrchestrationTool({
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
        mode: 'read',
        exec: async (args, ctx) => {
            const visible = ctx?.__visibleSkillsForAgent
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
    });

    registerOrchestrationTool({
        name: 'skill_read',
        displayName: 'Read skill file',
        description: 'Read a file inside a visible skill. Default path is SKILL.md. Use offset/limit for line ranges. Responses are capped at 50 KB; if truncated=true, use offset to continue.',
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
        mode: 'read',
        exec: async (args, ctx) => {
            const target = await resolveSkillFromCtx(args.name, ctx);
            return await skillsApi.readFile({
                scope: target.scope,
                name: args.name,
                path: args.path,
                offset: args.offset,
                limit: args.limit,
            });
        },
    });

    registerOrchestrationTool({
        name: 'skill_search',
        displayName: 'Search within skill',
        description: 'Regex search inside a single visible skill\'s files. Returns grep -n style output: one matched line per result as "{skill_name}/{path}:{lineno}: {line_content}". All files are scanned if `path` is omitted.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Skill name' },
                pattern: {
                    type: 'string',
                    description: 'JavaScript RegExp source. Match literal text by escaping regex metacharacters (e.g. \\. \\[ \\( \\\\). Prefer non-greedy quantifiers (.*? \\w+?) by default.',
                },
                flags: {
                    type: 'string',
                    description: "RegExp flags. 'gm' by default. 'g' is auto-injected if you omit it.",
                    default: 'gm',
                },
                path: { type: 'string', description: 'Optional file path within the skill. All files are scanned if omitted.' },
            },
            required: ['name', 'pattern'],
        },
        mode: 'read',
        exec: async (args, ctx) => {
            const pattern = String(args?.pattern ?? '');
            if (!pattern) {
                throw new Error('skill_search: pattern must be non-empty. To match literal text, escape regex metacharacters.');
            }
            const flags = typeof args?.flags === 'string' && args.flags.length > 0 ? args.flags : 'gm';
            const target = await resolveSkillFromCtx(args.name, ctx);

            // Determine which files to scan. Explicit `path` short-circuits
            // the listing; otherwise we walk every file the skill exposes
            // (SKILL.md first per skillsApi.listFiles' sort contract).
            let paths;
            if (args?.path) {
                paths = [String(args.path)];
            } else {
                const listed = await skillsApi.listFiles({ scope: target.scope, name: args.name });
                const files = Array.isArray(listed?.files) ? listed.files : [];
                paths = files
                    .filter((f) => f && !f.isBinary && typeof f.path === 'string')
                    .map((f) => f.path);
            }

            const units = [];
            for (const p of paths) {
                const file = await skillsApi.readFile({
                    scope: target.scope,
                    name: args.name,
                    path: p,
                });
                const content = typeof file === 'string' ? file : String(file?.content ?? '');
                units.push({ prefix: `${args.name}/${p}`, content });
            }
            return gatherGrepMatches(units, pattern, flags);
        },
    });
}

/**
 * Unregister the three skill tools. Used by tests and (potentially) by a
 * disable-skills toggle. Idempotent — names not present are silent no-ops.
 */
export function unregisterSkillOrchestrationTools() {
    for (const name of SKILL_TOOL_NAMES) {
        unregisterOrchestrationTool(name);
    }
}
