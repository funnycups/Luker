// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * iter-studio-side skill management tool catalog.
 *
 * Plan 2 Unit 7. Exposes the spec §6.1 tools to the iter-studio AI so it
 * can manage skills as part of the orchestrator design conversation.
 * Four categories totalling 17 tools (the unit title says "15-tool" but
 * the actual spec breakdown — 4 inventory + 7 authoring + 3 policy +
 * 3 migration — sums to 17; we ship all 17):
 *
 *   Inventory inspection (4 — read-only):
 *     skill_list_visible, skill_inspect, skill_read_content, skill_search_content
 *
 *   Authoring (7 — server-side writes through skillsApi):
 *     skill_create, skill_update_content, skill_edit_content,
 *     skill_update_frontmatter, skill_rename, skill_change_scope, skill_delete
 *
 *   Policy binding (3 — mutates the iter-studio working profile in place;
 *   surfaces as a pending edit the user reviews + applies):
 *     skill_bind_to_agent, skill_unbind_from_agent, skill_set_mode_defaults
 *
 *   Migration helpers (3 — assist long-systemPrompt extraction without
 *   reducing prompt intensity):
 *     skill_propose_extraction, skill_extract_from_text,
 *     skill_replace_in_systemprompt
 *
 * Wire model:
 *
 *   - studio.js's `runIterationTurn` splits tool calls into inline-executed
 *     (lorebook reads/writes, simulate) vs sandbox-diff edit tools. ALL 17
 *     skill tools are inline-executed: 14 only touch server state, and the
 *     3 policy-binding tools synthesize a sandbox-diff edit themselves
 *     (cloning state.live, applying the mutation, and emitting
 *     `{op:'set', path:'', oldValue, newValue}` so the user reviews + applies
 *     in the normal flow).
 *
 *   - This module exports `SKILL_ITER_STUDIO_TOOL_DEFS` (OpenAI-shape tool
 *     defs spliced into the catalog by studio.js), `isSkillIterStudioTool`
 *     (predicate routing into the inline-executed path), and
 *     `runSkillIterStudioTool` (the dispatcher studio.js calls per matched
 *     tool call).
 *
 *   - `runSkillIterStudioTool` returns one of three shapes:
 *       { ok: true, result: ... }                    plain server-side result
 *       { ok: true, result: ..., pendingEdit: {...} }  mutated working profile
 *       { ok: false, error: '...' }                    handled failure
 *
 *     The pendingEdit shape mirrors normalizeToolCallToEditInline's coarse
 *     `{op:'set', path:'', oldValue, newValue}` so it slots directly into
 *     state.pendingEdits and applies through the existing applyPendingEdits
 *     path. No special-casing in apply.
 *
 *   - studio.js owns the working-profile mutation API surface; this module
 *     receives a `mutationCtx` bag with the current working profile and
 *     mode, and never touches studio internals directly. Tests stub the bag.
 */

import { skillsApi } from '../../skills/api.js';
import { yaml } from '../../../lib.js';

// ────────────────────────────────────────────────────────────────────────────
// Tool names (kept in a frozen set so isSkillIterStudioTool is a fast lookup
// and there's a single source of truth for tests + studio.js to import).
// ────────────────────────────────────────────────────────────────────────────
export const SKILL_ITER_STUDIO_TOOL_NAMES = Object.freeze([
    // Inventory (4)
    'skill_list_visible',
    'skill_inspect',
    'skill_read_content',
    'skill_search_content',
    // Authoring (7)
    'skill_create',
    'skill_update_content',
    'skill_edit_content',
    'skill_update_frontmatter',
    'skill_rename',
    'skill_change_scope',
    'skill_delete',
    // Policy binding (3)
    'skill_bind_to_agent',
    'skill_unbind_from_agent',
    'skill_set_mode_defaults',
    // Migration helpers (3)
    'skill_propose_extraction',
    'skill_extract_from_text',
    'skill_replace_in_systemprompt',
]);

const SKILL_ITER_STUDIO_TOOL_NAME_SET = new Set(SKILL_ITER_STUDIO_TOOL_NAMES);

/**
 * Predicate matching any tool name dispatched by this module. studio.js
 * uses this to route calls into the inline-executed branch alongside
 * lorebook reads/writes + simulate. Names that don't match fall through
 * to the sandbox-diff edit-tool path.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isSkillIterStudioTool(name) {
    return SKILL_ITER_STUDIO_TOOL_NAME_SET.has(String(name || ''));
}

// ────────────────────────────────────────────────────────────────────────────
// Scope helpers. Tools accept either a structured scope object (preferred —
// matches the REST API shape) or the literal string 'global'. Tests
// frequently pass the string form for brevity, so normalize once at the top
// of each handler.
// ────────────────────────────────────────────────────────────────────────────

function normalizeScope(scope) {
    if (!scope) return { kind: 'global' };
    if (scope === 'global' || scope === 'all') return { kind: 'global' };
    if (typeof scope === 'string') return { kind: 'global' };
    if (scope.kind === 'global') return { kind: 'global' };
    if (scope.kind === 'preset' && scope.apiId && scope.name) {
        return { kind: 'preset', apiId: String(scope.apiId), name: String(scope.name) };
    }
    if (scope.kind === 'character' && scope.characterFile) {
        return { kind: 'character', characterFile: String(scope.characterFile) };
    }
    throw new Error(`invalid scope: ${JSON.stringify(scope)}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Frontmatter merge for skill_update_frontmatter. Reads SKILL.md, parses the
// YAML header, merges the patch, serializes back. Null values in patch delete
// keys; everything else assigns. Body (after the frontmatter `---`) is
// preserved verbatim.
// ────────────────────────────────────────────────────────────────────────────

function splitFrontmatter(content) {
    const text = String(content || '').replace(/\r\n/g, '\n');
    if (!text.startsWith('---\n')) {
        throw new Error('SKILL.md missing opening YAML frontmatter (---)');
    }
    const rest = text.slice(4);
    const closeIdx = rest.indexOf('\n---');
    if (closeIdx === -1) {
        throw new Error('SKILL.md frontmatter is not closed (---)');
    }
    const yamlBlock = rest.slice(0, closeIdx);
    // Body starts after `\n---` (the closing marker), skipping the trailing
    // newline that always follows it in well-formed SKILL.md.
    const afterClose = rest.slice(closeIdx + 4);
    const body = afterClose.startsWith('\n') ? afterClose.slice(1) : afterClose;
    return { yamlBlock, body };
}

function mergeFrontmatterPatch(currentObj, patch) {
    const merged = { ...(currentObj && typeof currentObj === 'object' ? currentObj : {}) };
    if (!patch || typeof patch !== 'object') return merged;
    for (const [k, v] of Object.entries(patch)) {
        if (v === null) {
            delete merged[k];
        } else {
            merged[k] = v;
        }
    }
    return merged;
}

/**
 * Apply a patch to the frontmatter of a SKILL.md string. Exported for unit
 * testing — the live skill_update_frontmatter handler is a thin wrapper that
 * reads the file, calls this helper, and writes it back.
 *
 * @param {string} content - raw SKILL.md content
 * @param {object} patch - keys to assign or delete (null = delete)
 * @returns {string} merged SKILL.md content
 */
export function applyFrontmatterPatch(content, patch) {
    const { yamlBlock, body } = splitFrontmatter(content);
    const parsed = yaml.parse(yamlBlock) || {};
    const merged = mergeFrontmatterPatch(parsed, patch);
    const newYaml = yaml.stringify(merged).replace(/\n$/, '');
    return `---\n${newYaml}\n---\n${body}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Working-profile mutation helpers. Each policy-binding tool clones the
// working profile, applies its change, and returns a pendingEdit. The clone
// uses structuredClone so studio.js's existing applyPendingEdits path (which
// also structuredClones on apply) sees a clean before/after pair.
// ────────────────────────────────────────────────────────────────────────────

function resolveAgentSkillsContainer(profile, agentId) {
    if (!profile || typeof profile !== 'object') return null;
    // Director: mainAgent + subAgents[]
    if (profile.mainAgent || Array.isArray(profile.subAgents)) {
        if (agentId === 'main' || agentId === 'mainAgent') {
            if (!profile.mainAgent || typeof profile.mainAgent !== 'object') {
                profile.mainAgent = {};
            }
            return profile.mainAgent;
        }
        if (Array.isArray(profile.subAgents)) {
            const idx = profile.subAgents.findIndex(a => String(a?.id || '') === String(agentId));
            if (idx >= 0) return profile.subAgents[idx];
        }
    }
    // Agenda: agents map keyed by id
    if (profile.agents && typeof profile.agents === 'object' && !Array.isArray(profile.agents)) {
        if (Object.prototype.hasOwnProperty.call(profile.agents, agentId)) {
            return profile.agents[agentId];
        }
    }
    // Spec: stages[].nodes[] keyed by node id
    if (profile.spec && Array.isArray(profile.spec.stages)) {
        for (const stage of profile.spec.stages) {
            if (!stage || !Array.isArray(stage.nodes)) continue;
            const found = stage.nodes.find(n => String(n?.id || '') === String(agentId));
            if (found) return found;
        }
    }
    // Loop: flat profile = single agent. Match either explicit 'loop' / 'agent'
    // alias OR the case where no agentId is meaningful (loop has one slot).
    if (typeof profile.system_prompt === 'string' && (agentId === 'loop' || agentId === 'agent' || !agentId)) {
        return profile;
    }
    return null;
}

function ensureAgentSkillsField(container) {
    if (!container.skills || typeof container.skills !== 'object') {
        container.skills = { visible: [], deny: [] };
    }
    if (!Array.isArray(container.skills.visible)) container.skills.visible = [];
    if (!Array.isArray(container.skills.deny)) container.skills.deny = [];
}

function ensureModeSkillsField(profile) {
    if (!profile.skills || typeof profile.skills !== 'object') {
        profile.skills = { visible: ['*'], deny: [] };
    }
    if (!Array.isArray(profile.skills.visible)) profile.skills.visible = ['*'];
    if (!Array.isArray(profile.skills.deny)) profile.skills.deny = [];
}

// ────────────────────────────────────────────────────────────────────────────
// Long-systemPrompt heuristic for skill_propose_extraction.
//
// v2 (Plan 3 Unit 3): paragraph-level segmentation with rule-keyword filter.
// Each agent's systemPrompt is split on blank lines (`\n{2,}`), filtered to
// paragraphs >= MIN_PARAGRAPH_CHARS that match the EN/ZH rule keyword regex,
// and each match becomes its own extraction candidate. Falls back to a single
// whole-prompt candidate (the v1 behaviour) only when:
//   - no paragraphs matched the keyword filter AND
//   - the overall prompt exceeds FALLBACK_WHOLE_MIN_CHARS
// so we still produce SOMETHING for opaque long prompts, but prefer
// paragraph-granular candidates whenever the agent author signposted rules.
//
// The caller (iter-studio AI) refines the slice/replacement before invoking
// skill_extract_from_text, which always copies verbatim.
// ────────────────────────────────────────────────────────────────────────────

export const DEFAULT_EXTRACTION_MIN_CHARS = 1000;
export const MIN_PARAGRAPH_CHARS = 100;
export const FALLBACK_WHOLE_MIN_CHARS = 500;

/**
 * Rule-style keywords used to identify paragraphs worth extracting into a
 * skill. Matches English markers (rule/principle/never/always/must/forbidden/
 * required) as case-insensitive word boundaries plus a hand-picked set of
 * Chinese imperative markers commonly used in director-style prompts
 * (重要 / 必须 / 禁止 / 始终 / 永远 / 绝不 / 铁律). Word boundary `\b` does not
 * apply to CJK characters, so they're listed as bare patterns alongside the
 * boundary-anchored English alternation.
 */
export const RULE_KEYWORDS_RE = /\b(rule|principle|never|always|must|forbidden|required)\b|重要|必须|禁止|始终|永远|绝不|铁律/i;

function listAgentsForExtraction(profile) {
    const agents = [];
    if (!profile || typeof profile !== 'object') return agents;
    if (profile.mainAgent && typeof profile.mainAgent === 'object') {
        agents.push({ agentId: 'main', container: profile.mainAgent });
    }
    if (Array.isArray(profile.subAgents)) {
        for (const a of profile.subAgents) {
            if (a && a.id) agents.push({ agentId: String(a.id), container: a });
        }
    }
    if (profile.agents && typeof profile.agents === 'object' && !Array.isArray(profile.agents)) {
        for (const [id, a] of Object.entries(profile.agents)) {
            if (a && typeof a === 'object') agents.push({ agentId: id, container: a });
        }
    }
    // Loop mode stores the prompt as `system_prompt` (snake_case) on the
    // profile root — not `systemPrompt`. Adapt by yielding a synthetic
    // container whose `systemPrompt` mirrors `profile.system_prompt` so the
    // per-agent loop below can read it uniformly.
    if (typeof profile.system_prompt === 'string') {
        agents.push({ agentId: 'loop', container: { systemPrompt: profile.system_prompt } });
    }
    if (profile.presets && typeof profile.presets === 'object') {
        for (const [id, p] of Object.entries(profile.presets)) {
            if (p && typeof p === 'object') agents.push({ agentId: id, container: p });
        }
    }
    return agents;
}

function sanitizeIdForSkillName(id) {
    return String(id || '').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
}

/**
 * Build a safe, length-bounded skill name from `<agentId>-<words>-zh`.
 * Used for paragraph candidates. The "words" portion is the first three
 * "tokens" of the paragraph (Latin letters/digits + CJK characters), so the
 * generated name carries a hint of the paragraph's topic without overflowing
 * the [a-z0-9_-]+ skill name rule. Total length is clamped to 60 chars.
 */
export function buildParagraphSkillName(agentId, paragraph) {
    const safeAgent = sanitizeIdForSkillName(agentId);
    // Strip everything that isn't a Latin letter/digit, CJK, or whitespace —
    // then collapse whitespace into single hyphens. CJK characters survive
    // here, but get filtered out in the ASCII pass below since skill names
    // are [a-z0-9_-]+ only.
    const cleaned = String(paragraph || '')
        .replace(/[^\w一-鿿\s]/g, ' ')
        .trim();
    const tokens = cleaned.split(/\s+/).filter(Boolean).slice(0, 3);
    const slug = tokens.join('-').toLowerCase();
    // Drop any character that isn't part of the skill name charset, then
    // collapse consecutive hyphens and trim. If the slug becomes empty after
    // that (e.g. CJK-only paragraph), use `rule` as the placeholder slug
    // so the final name is `${agent}-rule-zh` rather than `${agent}-zh`.
    const asciiSlug = slug.replace(/[^a-z0-9_-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const effectiveSlug = asciiSlug.length > 0 ? asciiSlug : 'rule';
    const raw = `${safeAgent}-${effectiveSlug}-zh`;
    return raw.slice(0, 60).replace(/-+$/, '');
}

/**
 * Pure function: given a working profile, list extraction candidates per the
 * v2 heuristic (paragraph segmentation + keyword filter, with whole-prompt
 * fallback). Exported for unit testing.
 *
 * @param {object} profile
 * @param {{minChars?: number, minParagraphChars?: number}} [opts]
 * @returns {Array<{agentId: string, suggestedName: string, scope: object, contentSlice: string, replacementText: string, description: string, paragraphIndex?: number}>}
 */
export function computeExtractionCandidates(profile, opts = {}) {
    const minChars = Number.isFinite(opts.minChars) ? opts.minChars : DEFAULT_EXTRACTION_MIN_CHARS;
    const minParagraphChars = Number.isFinite(opts.minParagraphChars)
        ? opts.minParagraphChars
        : MIN_PARAGRAPH_CHARS;
    const agents = listAgentsForExtraction(profile);
    const candidates = [];
    for (const { agentId, container } of agents) {
        const prompt = String(container?.systemPrompt || '');
        if (prompt.length < minChars) continue;

        // Paragraph-level pass: split on blank lines, keep paragraphs that
        // (a) are at least minParagraphChars long and (b) match the rule
        // keyword regex.
        const paragraphs = prompt.split(/\n{2,}/);
        const perAgent = [];
        const usedNames = new Set();
        for (let i = 0; i < paragraphs.length; i++) {
            const p = paragraphs[i];
            if (!p || p.trim().length === 0) continue;
            if (p.length < minParagraphChars) continue;
            if (!RULE_KEYWORDS_RE.test(p)) continue;
            let suggestedName = buildParagraphSkillName(agentId, p);
            // Ensure uniqueness within the agent — append `-2`, `-3`, … on
            // collision so two near-identical paragraphs both produce a
            // valid candidate name.
            if (usedNames.has(suggestedName)) {
                let n = 2;
                while (usedNames.has(`${suggestedName}-${n}`)) n++;
                suggestedName = `${suggestedName}-${n}`;
            }
            usedNames.add(suggestedName);
            const firstLine = p.split('\n')[0].slice(0, 60);
            perAgent.push({
                agentId,
                suggestedName,
                scope: { kind: 'global' },
                contentSlice: p,
                replacementText: `参考: skill \`${suggestedName}\` — ${firstLine}...`,
                description: `Extracted from ${agentId} systemPrompt (paragraph ${i})`,
                paragraphIndex: i,
            });
        }

        if (perAgent.length > 0) {
            candidates.push(...perAgent);
            continue;
        }

        // Fallback: no keyword-bearing paragraph, but the prompt is long
        // enough that we should still propose SOMETHING. Surface the whole
        // prompt as one candidate so the AI can refine. Skip when the prompt
        // is below FALLBACK_WHOLE_MIN_CHARS — too short to be worth a skill.
        if (prompt.length > FALLBACK_WHOLE_MIN_CHARS) {
            const safeId = sanitizeIdForSkillName(agentId);
            const suggestedName = `${safeId}-rules-extracted-zh`;
            candidates.push({
                agentId,
                suggestedName,
                scope: { kind: 'global' },
                contentSlice: prompt,
                replacementText: `参考: skill \`${suggestedName}\``,
                description: `Extracted from ${agentId} systemPrompt`,
                paragraphIndex: 0,
            });
        }
    }
    return candidates;
}

// ────────────────────────────────────────────────────────────────────────────
// Tool defs. OpenAI-shape; spliced into the iter-studio catalog by studio.js
// alongside CONTROL_TOOL_DEFS. Names match SKILL_ITER_STUDIO_TOOL_NAMES.
// ────────────────────────────────────────────────────────────────────────────

const SCOPE_SCHEMA = {
    type: 'object',
    description: 'Skill scope. Use {kind:\'global\'} for shared skills, {kind:\'preset\', apiId, name} for connection-profile-bound, {kind:\'character\', characterFile} for card-bound. Defaults to global when omitted.',
    properties: {
        kind: { type: 'string', enum: ['global', 'preset', 'character'] },
        apiId: { type: 'string' },
        name: { type: 'string' },
        characterFile: { type: 'string' },
    },
    required: ['kind'],
};

function fn(name, description, parameters) {
    return {
        type: 'function',
        function: { name, description, parameters },
    };
}

export const SKILL_ITER_STUDIO_TOOL_DEFS = Object.freeze([
    // ── Inventory inspection ────────────────────────────────────────────
    fn(
        'skill_list_visible',
        'List the skills currently visible to a specific agent in the orchestrator profile being edited. When agentId is omitted, returns the union visible to ALL agents (mode-level visibility). Use this before proposing extraction or binding decisions.',
        {
            type: 'object',
            properties: {
                agentId: { type: 'string', description: 'Optional agent id (sub-agent id, main, or agenda agent key). Omit to list mode-level visible skills.' },
            },
        },
    ),
    fn(
        'skill_inspect',
        'Inspect a single skill: returns frontmatter, file tree (path + size + binary flag), and total size in bytes. Does NOT return file bodies — use skill_read_content for that.',
        {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Skill name.' },
                scope: SCOPE_SCHEMA,
            },
            required: ['name'],
        },
    ),
    fn(
        'skill_read_content',
        'Read a file inside a skill. Defaults to SKILL.md when path is omitted. Supports offset/limit (1-based line numbers) for large files.',
        {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Skill name.' },
                scope: SCOPE_SCHEMA,
                path: { type: 'string', description: 'File path within the skill (defaults to SKILL.md).' },
                offset: { type: 'integer', description: '1-based starting line number.' },
                limit: { type: 'integer', description: 'Number of lines to read.' },
            },
            required: ['name'],
        },
    ),
    fn(
        'skill_search_content',
        'Search for a substring inside a skill\'s files. Case-insensitive; returns matching snippets with file path + line ref.',
        {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Skill name.' },
                scope: SCOPE_SCHEMA,
                query: { type: 'string', description: 'Substring to search.' },
            },
            required: ['name', 'query'],
        },
    ),

    // ── Authoring ────────────────────────────────────────────────────────
    fn(
        'skill_create',
        'Create a brand-new skill from a description and an initial SKILL.md body. Optional `files` array stages additional non-SKILL.md files (each {path, encoding:\'utf8\'|\'base64\', content}).',
        {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'New skill name (must match [a-z0-9_-]+).' },
                scope: SCOPE_SCHEMA,
                description: { type: 'string', description: 'One-line description used in the skill catalog (becomes frontmatter description).' },
                body: { type: 'string', description: 'Markdown body for SKILL.md (after the frontmatter block). Will be wrapped with --- name/description --- frontmatter automatically.' },
                files: {
                    type: 'array',
                    description: 'Optional additional files. Each {path, encoding, content}.',
                    items: { type: 'object' },
                },
            },
            required: ['name', 'description', 'body'],
        },
    ),
    fn(
        'skill_update_content',
        'Replace the entire content of a file inside an existing skill. Pair with expectedSha256 (optional) for optimistic concurrency.',
        {
            type: 'object',
            properties: {
                name: { type: 'string' },
                scope: SCOPE_SCHEMA,
                path: { type: 'string', description: 'File path within the skill (e.g. SKILL.md, examples/foo.md).' },
                content: { type: 'string', description: 'Full new file content.' },
                expectedSha256: { type: 'string', description: 'Optional sha256 of the pre-edit file content for optimistic concurrency.' },
            },
            required: ['name', 'path', 'content'],
        },
    ),
    fn(
        'skill_edit_content',
        'Find-and-replace a substring inside a single file. Default replaces the FIRST occurrence; set replaceAll=true for all. The substring must appear at least once or the edit fails.',
        {
            type: 'object',
            properties: {
                name: { type: 'string' },
                scope: SCOPE_SCHEMA,
                path: { type: 'string' },
                oldString: { type: 'string', description: 'Substring to find (must appear at least once).' },
                newString: { type: 'string', description: 'Replacement.' },
                replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' },
            },
            required: ['name', 'path', 'oldString', 'newString'],
        },
    ),
    fn(
        'skill_update_frontmatter',
        'Patch SKILL.md frontmatter without touching the body. Patch keys with non-null values are assigned; null values delete the key.',
        {
            type: 'object',
            properties: {
                name: { type: 'string' },
                scope: SCOPE_SCHEMA,
                patch: { type: 'object', description: 'Frontmatter field patch. e.g. {description: "new description", tags: ["a","b"]}. null value deletes the key.' },
            },
            required: ['name', 'patch'],
        },
    ),
    fn(
        'skill_rename',
        'Rename a skill within its current scope. The new name must match [a-z0-9_-]+ and not collide with an existing skill in that scope.',
        {
            type: 'object',
            properties: {
                scope: SCOPE_SCHEMA,
                fromName: { type: 'string' },
                toName: { type: 'string' },
            },
            required: ['fromName', 'toName'],
        },
    ),
    fn(
        'skill_change_scope',
        'Move a skill from one scope to another (e.g. global → character). The skill keeps its name.',
        {
            type: 'object',
            properties: {
                name: { type: 'string' },
                fromScope: SCOPE_SCHEMA,
                toScope: SCOPE_SCHEMA,
            },
            required: ['name', 'fromScope', 'toScope'],
        },
    ),
    fn(
        'skill_delete',
        'Permanently delete a skill (all files). Cannot be undone — confirm with the user before calling.',
        {
            type: 'object',
            properties: {
                name: { type: 'string' },
                scope: SCOPE_SCHEMA,
            },
            required: ['name'],
        },
    ),

    // ── Policy binding (mutates working profile) ─────────────────────────
    fn(
        'skill_bind_to_agent',
        'Add a skill name to an agent\'s visible or deny list in the working orchestrator profile. Emits a sandbox-diff pending edit for the user to review and apply. Use agentId \'main\' for the director main agent, the sub-agent id for sub-agents, the agenda agent key for agenda agents, the node id for spec nodes, or \'loop\' for the loop mode\'s single agent.',
        {
            type: 'object',
            properties: {
                agentId: { type: 'string', description: 'Agent id (main / sub-agent id / agenda key / spec node id / \'loop\').' },
                skillName: { type: 'string', description: 'Skill name to add (must exist in the inventory).' },
                list: { type: 'string', enum: ['visible', 'deny'], description: 'Which list to add to.' },
            },
            required: ['agentId', 'skillName', 'list'],
        },
    ),
    fn(
        'skill_unbind_from_agent',
        'Remove a skill name from an agent\'s visible or deny list in the working profile. Emits a pending edit.',
        {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                skillName: { type: 'string' },
                list: { type: 'string', enum: ['visible', 'deny'] },
            },
            required: ['agentId', 'skillName', 'list'],
        },
    ),
    fn(
        'skill_set_mode_defaults',
        'Replace the mode-level skills field on the working profile. visible/deny each accept a list of skill names; use [\'*\'] to mean \'all skills visible to the mode\'. Emits a pending edit.',
        {
            type: 'object',
            properties: {
                visible: { type: 'array', items: { type: 'string' }, description: 'Mode-level visible list. Use [\'*\'] for wildcard.' },
                deny: { type: 'array', items: { type: 'string' }, description: 'Mode-level deny list.' },
            },
        },
    ),

    // ── Migration helpers ────────────────────────────────────────────────
    fn(
        'skill_propose_extraction',
        'Analyze an agent\'s systemPrompt in the working profile and propose extraction candidates. v2 heuristic: paragraphs (split on blank lines) at least 100 chars long whose text contains rule keywords (rule/principle/never/always/must/forbidden/required + 重要/必须/禁止/始终/永远/绝不/铁律) each become a standalone candidate. When no paragraph matches the keyword filter, falls back to one whole-prompt candidate. The AI is expected to refine the slice / replacement text before calling skill_extract_from_text.',
        {
            type: 'object',
            properties: {
                agentId: { type: 'string', description: 'Optional. When set, only proposes for that agent. Omit to scan ALL agents in the working profile.' },
                minChars: { type: 'integer', description: 'Optional minimum systemPrompt length (default 1000).' },
            },
        },
    ),
    fn(
        'skill_extract_from_text',
        'Create a new skill from a verbatim text block (typically a slice of an agent\'s systemPrompt). The skill\'s SKILL.md body is the supplied text exactly — DO NOT paraphrase, compress, or reword. Use skill_replace_in_systemprompt afterwards to remove the corresponding text from the systemPrompt and insert a reference.',
        {
            type: 'object',
            properties: {
                sourceText: { type: 'string', description: 'Verbatim text content to extract into the skill body.' },
                suggestedName: { type: 'string', description: 'Skill name (must match [a-z0-9_-]+).' },
                scope: SCOPE_SCHEMA,
                description: { type: 'string', description: 'One-line description for the skill frontmatter.' },
            },
            required: ['sourceText', 'suggestedName', 'description'],
        },
    ),
    fn(
        'skill_replace_in_systemprompt',
        'Remove one or more character ranges from an agent\'s systemPrompt and splice in a replacement string (typically \'See skill X\' reference). removeRanges is a list of [start, end) character offsets, processed in descending order to keep indices stable. Mutates the working profile and emits a pending edit.',
        {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                removeRanges: {
                    type: 'array',
                    description: 'Array of [start, end) character offsets to remove.',
                    items: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
                },
                insertText: { type: 'string', description: 'Text inserted at the FIRST removed range (typically a skill reference). Use empty string to just delete.' },
            },
            required: ['agentId', 'removeRanges', 'insertText'],
        },
    ),
]);

// ────────────────────────────────────────────────────────────────────────────
// Dispatcher. studio.js calls runSkillIterStudioTool for any inline-executed
// call matching isSkillIterStudioTool. The mutationCtx bag supplies the
// in-flight working profile and identifying metadata. Return shape:
//
//   { ok: true, result: ... }
//   { ok: true, result: ..., pendingEdit: { op:'set', path:'', oldValue, newValue } }
//   { ok: false, error: '...' }
//
// Errors are returned (not thrown) so studio.js can present them as
// `status: 'fail'` tool results that the next LLM round sees.
// ────────────────────────────────────────────────────────────────────────────

const HANDLERS = {
    async skill_list_visible(args, mctx) {
        const profile = mctx.getWorkingProfile?.();
        const agentId = args?.agentId ? String(args.agentId) : null;
        const all = await skillsApi.list({ scope: 'all' });
        if (!agentId) {
            return {
                modeLevel: profile?.skills || null,
                inventory: all.map(s => ({ name: s.name, scope: s.scope, description: s.description })),
            };
        }
        const container = resolveAgentSkillsContainer(profile, agentId);
        if (!container) throw new Error(`agent not found in working profile: ${agentId}`);
        return {
            agentId,
            modeLevel: profile?.skills || null,
            agentLevel: container.skills || null,
            inventory: all.map(s => ({ name: s.name, scope: s.scope, description: s.description })),
        };
    },

    async skill_inspect(args) {
        if (!args?.name) throw new Error('name is required');
        const scope = normalizeScope(args.scope);
        const [entry, fileTree] = await Promise.all([
            skillsApi.get(args.name, scope),
            skillsApi.listFiles({ scope, name: args.name }),
        ]);
        if (!entry) throw new Error(`skill not found: ${args.name}`);
        const files = Array.isArray(fileTree?.files) ? fileTree.files : [];
        const sizeBytes = files.reduce((acc, f) => acc + (Number(f?.size) || 0), 0);
        return {
            name: entry.name,
            scope: entry.scope,
            frontmatter: {
                name: entry.name,
                description: entry.description,
                ...(entry.metadata || {}),
            },
            fileTree: files,
            sizeBytes,
        };
    },

    async skill_read_content(args) {
        if (!args?.name) throw new Error('name is required');
        return skillsApi.readFile({
            scope: normalizeScope(args.scope),
            name: String(args.name),
            path: args.path,
            offset: args.offset,
            limit: args.limit,
        });
    },

    async skill_search_content(args) {
        if (!args?.name) throw new Error('name is required');
        if (!args?.query) throw new Error('query is required');
        return skillsApi.search({
            scope: normalizeScope(args.scope),
            name: String(args.name),
            query: String(args.query),
        });
    },

    async skill_create(args) {
        if (!args?.name) throw new Error('name is required');
        if (!args?.description) throw new Error('description is required');
        if (typeof args?.body !== 'string') throw new Error('body is required');
        const name = String(args.name);
        const description = String(args.description);
        const body = String(args.body);
        const skillMd = `---\nname: ${name}\ndescription: ${description}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;
        const files = [{ path: 'SKILL.md', encoding: 'utf8', content: skillMd }];
        if (Array.isArray(args.files)) {
            for (const f of args.files) {
                if (!f || typeof f !== 'object') continue;
                if (!f.path || f.path === 'SKILL.md') continue;
                files.push({
                    path: String(f.path),
                    encoding: f.encoding === 'base64' ? 'base64' : 'utf8',
                    content: String(f.content || ''),
                });
            }
        }
        return skillsApi.install({ scope: normalizeScope(args.scope), payload: { files } });
    },

    async skill_update_content(args) {
        if (!args?.name) throw new Error('name is required');
        if (!args?.path) throw new Error('path is required');
        if (typeof args?.content !== 'string') throw new Error('content is required');
        return skillsApi.writeFile({
            scope: normalizeScope(args.scope),
            name: String(args.name),
            path: String(args.path),
            content: String(args.content),
            expectedSha256: args.expectedSha256,
        });
    },

    async skill_edit_content(args) {
        if (!args?.name) throw new Error('name is required');
        if (!args?.path) throw new Error('path is required');
        if (typeof args?.oldString !== 'string' || args.oldString.length === 0) {
            throw new Error('oldString is required (non-empty)');
        }
        if (typeof args?.newString !== 'string') throw new Error('newString is required');
        return skillsApi.editFile({
            scope: normalizeScope(args.scope),
            name: String(args.name),
            path: String(args.path),
            oldString: String(args.oldString),
            newString: String(args.newString),
            replaceAll: Boolean(args.replaceAll),
        });
    },

    async skill_update_frontmatter(args) {
        if (!args?.name) throw new Error('name is required');
        if (!args?.patch || typeof args.patch !== 'object') {
            throw new Error('patch is required');
        }
        const scope = normalizeScope(args.scope);
        const name = String(args.name);
        const current = await skillsApi.readFile({ scope, name, path: 'SKILL.md' });
        const currentContent = typeof current === 'string'
            ? current
            : (current && typeof current.content === 'string' ? current.content : '');
        const newContent = applyFrontmatterPatch(currentContent, args.patch);
        return skillsApi.writeFile({
            scope,
            name,
            path: 'SKILL.md',
            content: newContent,
        });
    },

    async skill_rename(args) {
        if (!args?.fromName) throw new Error('fromName is required');
        if (!args?.toName) throw new Error('toName is required');
        return skillsApi.rename(normalizeScope(args.scope), String(args.fromName), String(args.toName));
    },

    async skill_change_scope(args) {
        if (!args?.name) throw new Error('name is required');
        if (!args?.fromScope) throw new Error('fromScope is required');
        if (!args?.toScope) throw new Error('toScope is required');
        return skillsApi.moveScope(String(args.name), normalizeScope(args.fromScope), normalizeScope(args.toScope));
    },

    async skill_delete(args) {
        if (!args?.name) throw new Error('name is required');
        return skillsApi.delete(normalizeScope(args.scope), String(args.name));
    },

    // ── Policy binding ──────────────────────────────────────────────────
    async skill_bind_to_agent(args, mctx) {
        if (!args?.agentId) throw new Error('agentId is required');
        if (!args?.skillName) throw new Error('skillName is required');
        if (args.list !== 'visible' && args.list !== 'deny') {
            throw new Error('list must be \'visible\' or \'deny\'');
        }
        const profile = mctx.getWorkingProfile?.();
        if (!profile) throw new Error('working profile unavailable');
        const before = structuredClone(profile);
        const next = structuredClone(profile);
        const container = resolveAgentSkillsContainer(next, args.agentId);
        if (!container) throw new Error(`agent not found in working profile: ${args.agentId}`);
        ensureAgentSkillsField(container);
        const list = container.skills[args.list];
        if (!list.includes(args.skillName)) list.push(args.skillName);
        return {
            result: { ok: true, agentId: args.agentId, skillName: args.skillName, list: args.list, skills: container.skills },
            pendingEdit: { op: 'set', path: '', oldValue: before, newValue: next },
        };
    },

    async skill_unbind_from_agent(args, mctx) {
        if (!args?.agentId) throw new Error('agentId is required');
        if (!args?.skillName) throw new Error('skillName is required');
        if (args.list !== 'visible' && args.list !== 'deny') {
            throw new Error('list must be \'visible\' or \'deny\'');
        }
        const profile = mctx.getWorkingProfile?.();
        if (!profile) throw new Error('working profile unavailable');
        const before = structuredClone(profile);
        const next = structuredClone(profile);
        const container = resolveAgentSkillsContainer(next, args.agentId);
        if (!container) throw new Error(`agent not found in working profile: ${args.agentId}`);
        ensureAgentSkillsField(container);
        const list = container.skills[args.list];
        const idx = list.indexOf(args.skillName);
        if (idx >= 0) list.splice(idx, 1);
        return {
            result: { ok: true, agentId: args.agentId, skillName: args.skillName, list: args.list, skills: container.skills },
            pendingEdit: { op: 'set', path: '', oldValue: before, newValue: next },
        };
    },

    async skill_set_mode_defaults(args, mctx) {
        const profile = mctx.getWorkingProfile?.();
        if (!profile) throw new Error('working profile unavailable');
        const before = structuredClone(profile);
        const next = structuredClone(profile);
        ensureModeSkillsField(next);
        if (Array.isArray(args?.visible)) next.skills.visible = args.visible.map(String);
        if (Array.isArray(args?.deny)) next.skills.deny = args.deny.map(String);
        return {
            result: { ok: true, skills: next.skills },
            pendingEdit: { op: 'set', path: '', oldValue: before, newValue: next },
        };
    },

    // ── Migration helpers ───────────────────────────────────────────────
    async skill_propose_extraction(args, mctx) {
        const profile = mctx.getWorkingProfile?.();
        if (!profile) throw new Error('working profile unavailable');
        const minChars = Number.isInteger(args?.minChars) ? args.minChars : DEFAULT_EXTRACTION_MIN_CHARS;
        let candidates = computeExtractionCandidates(profile, { minChars });
        if (args?.agentId) {
            candidates = candidates.filter(c => c.agentId === String(args.agentId));
        }
        return {
            candidates,
            note: 'These are heuristic suggestions (paragraph-level when rule keywords match, whole-prompt otherwise). Refine the contentSlice and replacementText before calling skill_extract_from_text. The skill body MUST be verbatim — do not paraphrase or compress.',
        };
    },

    async skill_extract_from_text(args) {
        if (typeof args?.sourceText !== 'string' || args.sourceText.length === 0) {
            throw new Error('sourceText is required (non-empty)');
        }
        if (!args?.suggestedName) throw new Error('suggestedName is required');
        if (!args?.description) throw new Error('description is required');
        return HANDLERS.skill_create({
            name: String(args.suggestedName),
            description: String(args.description),
            body: String(args.sourceText),
            scope: args.scope,
        });
    },

    async skill_replace_in_systemprompt(args, mctx) {
        if (!args?.agentId) throw new Error('agentId is required');
        if (!Array.isArray(args.removeRanges)) throw new Error('removeRanges is required');
        if (typeof args.insertText !== 'string') throw new Error('insertText is required');
        const profile = mctx.getWorkingProfile?.();
        if (!profile) throw new Error('working profile unavailable');
        const before = structuredClone(profile);
        const next = structuredClone(profile);
        const container = resolveAgentSkillsContainer(next, args.agentId);
        if (!container) throw new Error(`agent not found in working profile: ${args.agentId}`);
        const sp = String(container.systemPrompt || '');
        // Sort ranges descending by start so later splices don't invalidate
        // earlier offsets. Insert the replacement text at the FIRST range
        // (smallest start) — that's the natural anchor for the "see skill X"
        // reference; subsequent ranges are pure deletions.
        const sorted = args.removeRanges
            .filter(r => Array.isArray(r) && r.length >= 2)
            .map(r => [Number(r[0]), Number(r[1])])
            .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e > s && e <= sp.length)
            .sort((a, b) => b[0] - a[0]);
        if (sorted.length === 0) throw new Error('no valid removeRanges (each must be [start, end) within systemPrompt bounds)');
        let text = sp;
        for (let i = 0; i < sorted.length; i++) {
            const [start, end] = sorted[i];
            const isFirstRange = (i === sorted.length - 1); // smallest start after desc sort
            const insertion = isFirstRange ? String(args.insertText) : '';
            text = text.slice(0, start) + insertion + text.slice(end);
        }
        container.systemPrompt = text;
        return {
            result: { ok: true, agentId: args.agentId, newLength: text.length, originalLength: sp.length },
            pendingEdit: { op: 'set', path: '', oldValue: before, newValue: next },
        };
    },
};

/**
 * Dispatch a single inline-executed skill tool call.
 *
 * @param {{name: string, args: object}} call
 * @param {{
 *   getWorkingProfile: () => object|null,
 * }} mutationCtx
 * @returns {Promise<
 *   | {ok: true, result: *, pendingEdit?: {op:string, path:string, oldValue:*, newValue:*}}
 *   | {ok: false, error: string}
 * >}
 */
export async function runSkillIterStudioTool(call, mutationCtx = {}) {
    const name = String(call?.name || '');
    const handler = HANDLERS[name];
    if (!handler) {
        return { ok: false, error: `not a skill iter-studio tool: ${name}` };
    }
    const args = (call?.args && typeof call.args === 'object') ? call.args : {};
    try {
        const out = await handler(args, mutationCtx);
        if (out && typeof out === 'object' && 'pendingEdit' in out) {
            return { ok: true, result: out.result, pendingEdit: out.pendingEdit };
        }
        return { ok: true, result: out };
    } catch (err) {
        return { ok: false, error: String(err?.message || err || 'unknown error') };
    }
}
