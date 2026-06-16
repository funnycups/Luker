// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * iter-studio-side skill management tool catalog.
 *
 * Plan 2 Unit 7. Exposes the spec §6.1 tools to the iter-studio AI so it
 * can manage skills as part of the orchestrator design conversation.
 * Four categories totalling 16 tools — 4 inventory + 7 authoring + 3
 * policy + 2 migration:
 *
 *   Inventory inspection (4 — read-only):
 *     skill_list_visible, skill_inspect, skill_read_content, skill_search_content
 *
 *   Authoring (7 — captured as user-reviewed proposals; commit only at Apply):
 *     skill_create, skill_update_content, skill_edit_content,
 *     skill_update_frontmatter, skill_rename, skill_change_scope, skill_delete
 *
 *   Policy binding (3 — mutates the iter-studio working profile in place;
 *   surfaces as a pending edit the user reviews + applies):
 *     skill_bind_to_agent, skill_unbind_from_agent, skill_set_mode_defaults
 *
 *   Migration helpers (2 — assist long-systemPrompt extraction without
 *   reducing prompt intensity. The AI inspects the systemPrompt directly
 *   from working_state and picks the slice itself; there is no
 *   heuristic candidate proposer — extraction judgment is the AI's job,
 *   not a regex in this module):
 *     skill_extract_from_text, skill_replace_in_systemprompt
 *
 * Wire model:
 *
 *   - studio.js's `runIterationTurn` splits tool calls into inline-executed
 *     (lorebook reads/writes, simulate) vs sandbox-diff edit tools. ALL 16
 *     skill tools are inline-executed. They split three ways:
 *       a) 4 inventory tools just return server data
 *       b) 3 policy-binding + 1 systemPrompt-splice tool mutate the working
 *          profile and emit a sandbox-diff `pendingEdit` so they ride
 *          state.pendingEdits + the apply / discard buttons
 *       c) 7 authoring tools (+ skill_extract_from_text which composes
 *          skill_create) DO NOT touch disk inline. They compute the
 *          before/after, attach a `pendingSkillEdit` blob (id, op{name,args},
 *          kind, before, after, identity), and return a slim ack to the LLM.
 *          The popup parks the blob on `state.pendingSkillEdits` for
 *          per-card Approve / Reject. Approved entries commit at Apply
 *          time by replaying the original op against current on-disk state
 *          — matching how lorebook proposals re-derive at commit so
 *          parallel-session drift surfaces as a fresh validation error
 *          instead of clobbering with a stale snapshot.
 *
 *   - This module exports `SKILL_ITER_STUDIO_TOOL_DEFS` (OpenAI-shape tool
 *     defs spliced into the catalog by studio.js), `isSkillIterStudioTool`
 *     (predicate routing into the inline-executed path), and
 *     `runSkillIterStudioTool` (the dispatcher studio.js calls per matched
 *     tool call).
 *
 *   - `runSkillIterStudioTool` returns one of three shapes:
 *       { ok: true, result: ... }                              read-only result
 *       { ok: true, result: ..., pendingEdit: {...} }          working-profile mutation
 *       { ok: true, result: ..., pendingSkillEdit: {...} }     authoring proposal
 *       { ok: false, error: '...' }                            handled failure
 *
 *     The pendingEdit shape mirrors normalizeToolCallToEditInline's coarse
 *     `{op:'set', path:'', oldValue, newValue}` so it slots directly into
 *     state.pendingEdits. pendingSkillEdit lives in its own bucket because
 *     the commit semantics differ (disk re-derive at Apply time, not
 *     profile-level diff merge).
 *
 *   - studio.js owns the working-profile mutation API surface; this module
 *     receives a `mutationCtx` bag with the current working profile and
 *     mode, and never touches studio internals directly. Tests stub the bag.
 *
 *   - `commitApprovedSkillProposal` is the disk-write helper studio.js
 *     calls at Apply time per approved entry. It's exported here (not
 *     inlined in studio.js) so the replay-against-disk logic and the
 *     compute-after logic stay in one module, matching the spec for each
 *     authoring tool.
 */

// iteration-library convention (mirrors lorebook-reads / lorebook-writes
// and the rest of iter-lib): never capture SillyTavern.getContext() at
// module load — the context may not be ready when the module first
// evaluates, and resolving lazily lets tests stub the surface per-call.
// The two helpers below resolve fresh each time; downstream callers
// invoke them directly (cheap — getContext() returns a stable singleton).
function getSkillsApi() {
    return SillyTavern.getContext().skills;
}
function getYaml() {
    return SillyTavern.getContext().lib.yaml;
}

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
    // Migration helpers (2)
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
    if (scope.kind === 'preset' && scope.name) {
        return { kind: 'preset', name: String(scope.name) };
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
    const yaml = getYaml();
    const { yamlBlock, body } = splitFrontmatter(content);
    const parsed = yaml.parse(yamlBlock) || {};
    const merged = mergeFrontmatterPatch(parsed, patch);
    const newYaml = yaml.stringify(merged).replace(/\n$/, '');
    return `---\n${newYaml}\n---\n${body}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Authoring proposal helpers. The 7 authoring tools + `skill_extract_from_text`
// (which composes `skill_create`) capture an op + before/after as a
// `pendingSkillEdit` and return a slim ack to the LLM. studio.js parks the
// blob on state.pendingSkillEdits and renders per-card approve/reject. At
// Apply time, studio.js calls `commitApprovedSkillProposal(op)` per approved
// entry — that function replays the original op against current on-disk
// state through skillsApi so parallel-session drift surfaces as a fresh
// validation error instead of clobbering with a stale snapshot. Mirrors how
// lorebook proposals re-derive at commit time.
// ────────────────────────────────────────────────────────────────────────────

function composeSkillMd(name, description, body) {
    const safeBody = String(body || '');
    return `---\nname: ${name}\ndescription: ${description}\n---\n${safeBody.startsWith('\n') ? safeBody : `\n${safeBody}`}`;
}

async function readFileSafe(scope, name, path) {
    const skillsApi = getSkillsApi();
    try {
        const raw = await skillsApi.readFile({ scope, name, path });
        if (typeof raw === 'string') return raw;
        if (raw && typeof raw.content === 'string') return raw.content;
        return null;
    } catch (err) {
        // Treat any read failure (typically a 404 for newly-created files)
        // as "not present" so callers can decide whether that's a soft
        // "before is empty" (frontmatter patch on a missing file is an
        // error; edit_content on a missing file is an error; create with
        // a name that already exists shouldn't end up here).
        if (String(err?.message || err).match(/404|not found/i)) return null;
        throw err;
    }
}

function proposalReturn({ kind, skillName, scope, path, before, after, op, extras }) {
    return {
        result: buildProposalAck({ kind, skillName, scope, path, op }),
        pendingSkillEdit: {
            kind,
            skillName,
            scope,
            path,
            before,
            after,
            op,
            ...(extras && typeof extras === 'object' ? { extras } : {}),
        },
    };
}

function buildProposalAck({ kind, skillName, scope, path, op }) {
    return {
        ok: true,
        proposed: true,
        kind,
        skill: skillName,
        scope,
        ...(path ? { path } : {}),
        tool: op?.name,
        message: 'Proposed for user approval. The change is NOT live yet — the user reviews this diff card and approves or rejects it; nothing reaches disk until the user clicks Apply. The iter-studio will PAUSE the auto-continue loop the moment any write proposal (profile edit, lorebook, skill) is staged: the next round will not fire until the user has fully resolved every pending card via Apply. You will then receive a synthetic user message describing exactly which proposals committed, which were rejected, and which surfaced commit errors. Continue planning subsequent work in your reasoning, but do not stack additional unrelated write proposals in this same round expecting them to commit alongside this one — the user reviews each card independently and the loop only resumes after the batch is settled.',
    };
}

/**
 * Commit a single approved skill proposal at Apply time. studio.js walks
 * the approved entries in order and calls this per entry. The op shape is
 * the one the handler captured at proposal time. Each branch replays the
 * tool args against current on-disk state via skillsApi, so a parallel
 * session that edited the same file between proposal and apply surfaces
 * as a fresh validation error (writeFile expectedSha256 / editFile
 * substring-missing) instead of clobbering with a stale after-image.
 *
 * Throws on failure so the caller can halt the walk and leave the
 * remaining approved entries pending.
 */
export async function commitApprovedSkillProposal(op) {
    if (!op || typeof op !== 'object' || !op.name) {
        throw new Error('commitApprovedSkillProposal: invalid op');
    }
    const skillsApi = getSkillsApi();
    const args = op.args && typeof op.args === 'object' ? op.args : {};
    switch (op.name) {
        case 'skill_create': {
            const files = [{
                path: 'SKILL.md',
                encoding: 'utf8',
                content: composeSkillMd(String(args.name), String(args.description), String(args.body || '')),
            }];
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
            return skillsApi.install({ scope: args.scope, payload: { files } });
        }
        case 'skill_update_content':
            return skillsApi.writeFile({
                scope: args.scope,
                name: args.name,
                path: args.path,
                content: args.content,
                expectedSha256: args.expectedSha256,
            });
        case 'skill_edit_content':
            return skillsApi.editFile({
                scope: args.scope,
                name: args.name,
                path: args.path,
                oldString: args.oldString,
                newString: args.newString,
                replaceAll: Boolean(args.replaceAll),
            });
        case 'skill_update_frontmatter': {
            // Re-derive after-image against current on-disk SKILL.md so a
            // parallel-session edit lands cleanly. If the file vanished
            // between proposal and apply, surface that as the error.
            const current = await readFileSafe(args.scope, args.name, 'SKILL.md');
            if (current === null) throw new Error(`SKILL.md not found at apply time: ${args.name}`);
            const newContent = applyFrontmatterPatch(current, args.patch);
            return skillsApi.writeFile({
                scope: args.scope,
                name: args.name,
                path: 'SKILL.md',
                content: newContent,
            });
        }
        case 'skill_rename':
            return skillsApi.rename(args.scope, args.fromName, args.toName);
        case 'skill_change_scope':
            return skillsApi.moveScope(args.name, args.fromScope, args.toScope);
        case 'skill_delete':
            return skillsApi.delete(args.scope, args.name);
        default:
            throw new Error(`commitApprovedSkillProposal: unknown op ${op.name}`);
    }
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
    // First-time seed uses the `'+'` inherit-sentinel from skill-resolution.js
    // (see `agentVisible[0] === '+'` branch there) so a bind/unbind on an agent
    // that previously had no skills field — i.e. one that was inheriting the
    // mode-level visible set in full — preserves that inheritance and merely
    // appends/removes one entry, rather than silently replacing the whole
    // visible set with the single bound name (effectively narrowing the agent
    // from "all skills" down to one).
    if (!container.skills || typeof container.skills !== 'object') {
        container.skills = { visible: ['+'], deny: [] };
    }
    if (!Array.isArray(container.skills.visible)) container.skills.visible = ['+'];
    if (!Array.isArray(container.skills.deny)) container.skills.deny = [];
}

function ensureModeSkillsField(profile) {
    if (!profile.skills || typeof profile.skills !== 'object') {
        profile.skills = { visible: ['*'], deny: [] };
    }
    if (!Array.isArray(profile.skills.visible)) profile.skills.visible = ['*'];
    if (!Array.isArray(profile.skills.deny)) profile.skills.deny = [];
}

/**
 * Extract the raw `skills` field that the resolver actually consults for a
 * given (profile, agentId) pair. Returns `{ visible, deny }` with array
 * values, or `null` when the agent has no skills field set (i.e. the
 * resolver will inherit the mode default for that agent).
 *
 * Used by `buildSkillVisibilityChange` to assemble the before/after snapshot
 * pinned onto a policy-binding tool's `pendingEdit`. The renderer in
 * studio.js consumes that snapshot to surface a human-readable "effective
 * skills" line above the raw structural diff card so the user sees what the
 * change means for runtime visibility (e.g. `[+, foo]` is "inherit mode +
 * foo", not "only foo").
 */
function readAgentSkillsField(profile, agentId) {
    const container = resolveAgentSkillsContainer(profile, agentId);
    if (!container || !container.skills || typeof container.skills !== 'object') return null;
    const visible = Array.isArray(container.skills.visible) ? [...container.skills.visible] : [];
    const deny = Array.isArray(container.skills.deny) ? [...container.skills.deny] : [];
    return { visible, deny };
}

function readModeSkillsField(profile) {
    if (!profile?.skills || typeof profile.skills !== 'object') {
        return { visible: ['*'], deny: [] };
    }
    return {
        visible: Array.isArray(profile.skills.visible) ? [...profile.skills.visible] : ['*'],
        deny: Array.isArray(profile.skills.deny) ? [...profile.skills.deny] : [],
    };
}

/**
 * Build the `skillVisibilityChange` blob that policy-binding tools attach to
 * their `pendingEdit`. Pure shape:
 *
 *   {
 *     kind: 'agent' | 'mode',
 *     agentId?: string,                // present iff kind === 'agent'
 *     list: 'visible' | 'deny',
 *     mode:  { before, after },        // mode-level raw fields (always present)
 *     agent?: { before, after },       // per-agent raw fields (kind === 'agent')
 *                                       // each side null when no field is set
 *   }
 *
 * The renderer in studio.js translates this into a "Skills now visible:
 * <effective set>" line — including expanding the `'+'` inherit sentinel
 * and the `'*'` wildcard against the mode default — so the user sees
 * runtime semantics rather than the literal `['+', 'foo']` shape.
 */
export function buildSkillVisibilityChange(beforeProfile, afterProfile, { kind, agentId, list }) {
    const out = {
        kind,
        list,
        mode: {
            before: readModeSkillsField(beforeProfile),
            after: readModeSkillsField(afterProfile),
        },
    };
    if (kind === 'agent') {
        out.agentId = String(agentId);
        out.agent = {
            before: readAgentSkillsField(beforeProfile, agentId),
            after: readAgentSkillsField(afterProfile, agentId),
        };
    }
    return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Tool defs. OpenAI-shape; spliced into the iter-studio catalog by studio.js
// alongside CONTROL_TOOL_DEFS. Names match SKILL_ITER_STUDIO_TOOL_NAMES.
// ────────────────────────────────────────────────────────────────────────────

const SCOPE_SCHEMA = {
    type: 'object',
    description: 'Skill scope. Use {kind:\'global\'} for shared skills, {kind:\'preset\', name} for preset-bound (preset-scope skills travel with the preset regardless of connection profile), {kind:\'character\', characterFile} for card-bound. Defaults to global when omitted.',
    properties: {
        kind: { type: 'string', enum: ['global', 'preset', 'character'] },
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
        'PROPOSAL: stage creation of a brand-new skill from a description and an initial SKILL.md body. Optional `files` array stages additional non-SKILL.md files (each {path, encoding:\'utf8\'|\'base64\', content}). The skill is NOT written to disk by this call — the user reviews a proposal card and the create commits at Apply time. You will receive `"proposed": true` as the success contract.',
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
        'PROPOSAL: stage a full-file replacement of a file inside an existing skill. The change is NOT written to disk by this call — the user reviews a line-by-line diff card and the write commits at Apply time. Pair with expectedSha256 (optional) for optimistic concurrency at commit time. You will receive `"proposed": true` as the success contract.',
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
        'PROPOSAL: stage a find-and-replace inside a single file. Default replaces the FIRST occurrence; set replaceAll=true for all. The substring must appear at least once or the proposal fails. The change is NOT written to disk by this call — the user reviews a line-by-line diff card and the write commits at Apply time. You will receive `"proposed": true` as the success contract.',
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
        'PROPOSAL: stage a frontmatter patch on SKILL.md without touching the body. Patch keys with non-null values are assigned; null values delete the key. The change is NOT written to disk by this call — the user reviews a line-by-line diff card and the write commits at Apply time. You will receive `"proposed": true` as the success contract.',
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
        'PROPOSAL: stage a rename of a skill within its current scope. The new name must match [a-z0-9_-]+ and not collide with an existing skill in that scope. The rename is NOT applied to disk by this call — the user reviews a proposal card and it commits at Apply time. You will receive `"proposed": true` as the success contract.',
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
        'PROPOSAL: stage a scope move (e.g. global → character). The skill keeps its name. The move is NOT applied to disk by this call — the user reviews a proposal card and it commits at Apply time. You will receive `"proposed": true` as the success contract.',
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
        'PROPOSAL: stage permanent deletion of a skill (all files). Cannot be undone once the user approves AND clicks Apply. The deletion is NOT applied to disk by this call — the user reviews a proposal card and it commits at Apply time. You will receive `"proposed": true` as the success contract.',
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
        'skill_extract_from_text',
        'PROPOSAL: create a new skill from a verbatim text block (typically a slice of an agent\'s systemPrompt that you selected yourself by reading working_state — there is no candidate-proposer tool). The skill\'s SKILL.md body is the supplied text exactly — DO NOT paraphrase, compress, or reword. The skill is NOT written to disk by this call — the user reviews a proposal card and the create commits at Apply time. Follow up with skill_replace_in_systemprompt to remove the slice and splice in a per-skill contextual pointer. You will receive `"proposed": true` as the success contract.',
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
        'Remove one or more character ranges from an agent\'s systemPrompt and splice in a replacement string at the first removed range. removeRanges is a list of [start, end) character offsets, processed in descending order to keep indices stable. Mutates the working profile and emits a pending edit. `insertText` is the pointer the running agent will read in place of the removed rules — compose it from scratch for THIS specific skill as a complete imperative sentence with three parts: (i) a trigger condition (when the running agent should consult the skill), (ii) the skill name, (iii) a one-line hint about what it covers. Every extraction gets its OWN pointer — never reuse a template across slices.',
        {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                removeRanges: {
                    type: 'array',
                    description: 'Array of [start, end) character offsets to remove.',
                    items: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
                },
                insertText: { type: 'string', description: 'Pointer text inserted at the FIRST removed range. Must be a complete imperative sentence naming a trigger condition, the skill, and a one-line hint about what it covers — composed per-skill, never a generic template. Use empty string only when the goal is pure deletion with no pointer left behind.' },
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
        const skillsApi = getSkillsApi();
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
        const skillsApi = getSkillsApi();
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
        return getSkillsApi().readFile({
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
        return getSkillsApi().search({
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
        const scope = normalizeScope(args.scope);
        const skillMd = composeSkillMd(name, description, body);
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
        const op = { name: 'skill_create', args: { name, description, body, scope, files: args.files } };
        return proposalReturn({
            kind: 'create',
            skillName: name,
            scope,
            path: 'SKILL.md',
            // For create, the diff card shows SKILL.md going from empty
            // string to its full body so the user sees the new file's
            // shape verbatim — same renderer the content-edit tools use.
            before: '',
            after: skillMd,
            extras: files.length > 1 ? { extraFiles: files.slice(1).map(f => f.path) } : null,
            op,
        });
    },

    async skill_update_content(args) {
        if (!args?.name) throw new Error('name is required');
        if (!args?.path) throw new Error('path is required');
        if (typeof args?.content !== 'string') throw new Error('content is required');
        const scope = normalizeScope(args.scope);
        const name = String(args.name);
        const path = String(args.path);
        const before = await readFileSafe(scope, name, path);
        return proposalReturn({
            kind: 'content',
            skillName: name,
            scope,
            path,
            before,
            after: String(args.content),
            op: {
                name: 'skill_update_content',
                args: {
                    name,
                    scope,
                    path,
                    content: String(args.content),
                    expectedSha256: args.expectedSha256,
                },
            },
        });
    },

    async skill_edit_content(args) {
        if (!args?.name) throw new Error('name is required');
        if (!args?.path) throw new Error('path is required');
        if (typeof args?.oldString !== 'string' || args.oldString.length === 0) {
            throw new Error('oldString is required (non-empty)');
        }
        if (typeof args?.newString !== 'string') throw new Error('newString is required');
        const scope = normalizeScope(args.scope);
        const name = String(args.name);
        const path = String(args.path);
        const replaceAll = Boolean(args.replaceAll);
        const before = await readFileSafe(scope, name, path);
        if (before === null) {
            throw new Error(`file not found: ${name}/${path}`);
        }
        if (!before.includes(args.oldString)) {
            throw new Error('oldString not found in file (substring must appear at least once)');
        }
        const after = replaceAll
            ? before.split(args.oldString).join(args.newString)
            : before.replace(args.oldString, args.newString);
        return proposalReturn({
            kind: 'content',
            skillName: name,
            scope,
            path,
            before,
            after,
            op: {
                name: 'skill_edit_content',
                args: {
                    name,
                    scope,
                    path,
                    oldString: String(args.oldString),
                    newString: String(args.newString),
                    replaceAll,
                },
            },
        });
    },

    async skill_update_frontmatter(args) {
        if (!args?.name) throw new Error('name is required');
        if (!args?.patch || typeof args.patch !== 'object') {
            throw new Error('patch is required');
        }
        const scope = normalizeScope(args.scope);
        const name = String(args.name);
        const before = await readFileSafe(scope, name, 'SKILL.md');
        if (before === null) {
            throw new Error(`SKILL.md not found: ${name}`);
        }
        const after = applyFrontmatterPatch(before, args.patch);
        return proposalReturn({
            kind: 'frontmatter',
            skillName: name,
            scope,
            path: 'SKILL.md',
            before,
            after,
            op: {
                name: 'skill_update_frontmatter',
                args: { name, scope, patch: args.patch },
            },
        });
    },

    async skill_rename(args) {
        if (!args?.fromName) throw new Error('fromName is required');
        if (!args?.toName) throw new Error('toName is required');
        const scope = normalizeScope(args.scope);
        const fromName = String(args.fromName);
        const toName = String(args.toName);
        return proposalReturn({
            kind: 'rename',
            skillName: fromName,
            scope,
            // Structural ops (rename/scope/delete) have no body diff — the
            // renderer surfaces a compact metadata card instead. We still
            // pass identity strings as `before`/`after` so the same data
            // shape works for tests that snapshot the proposal.
            before: { name: fromName },
            after: { name: toName },
            op: { name: 'skill_rename', args: { scope, fromName, toName } },
        });
    },

    async skill_change_scope(args) {
        if (!args?.name) throw new Error('name is required');
        if (!args?.fromScope) throw new Error('fromScope is required');
        if (!args?.toScope) throw new Error('toScope is required');
        const fromScope = normalizeScope(args.fromScope);
        const toScope = normalizeScope(args.toScope);
        const name = String(args.name);
        return proposalReturn({
            kind: 'change_scope',
            skillName: name,
            scope: fromScope,
            before: { scope: fromScope },
            after: { scope: toScope },
            op: { name: 'skill_change_scope', args: { name, fromScope, toScope } },
        });
    },

    async skill_delete(args) {
        if (!args?.name) throw new Error('name is required');
        const scope = normalizeScope(args.scope);
        const name = String(args.name);
        return proposalReturn({
            kind: 'delete',
            skillName: name,
            scope,
            before: { exists: true },
            after: { exists: false },
            op: { name: 'skill_delete', args: { name, scope } },
        });
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
            pendingEdit: {
                op: 'set', path: '', oldValue: before, newValue: next,
                skillVisibilityChange: buildSkillVisibilityChange(before, next, { kind: 'agent', agentId: String(args.agentId), list: args.list }),
            },
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
            pendingEdit: {
                op: 'set', path: '', oldValue: before, newValue: next,
                skillVisibilityChange: buildSkillVisibilityChange(before, next, { kind: 'agent', agentId: String(args.agentId), list: args.list }),
            },
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
            pendingEdit: {
                op: 'set', path: '', oldValue: before, newValue: next,
                skillVisibilityChange: buildSkillVisibilityChange(before, next, { kind: 'mode', list: 'visible' }),
            },
        };
    },

    // ── Migration helpers ───────────────────────────────────────────────
    async skill_extract_from_text(args) {
        if (typeof args?.sourceText !== 'string' || args.sourceText.length === 0) {
            throw new Error('sourceText is required (non-empty)');
        }
        if (!args?.suggestedName) throw new Error('suggestedName is required');
        if (!args?.description) throw new Error('description is required');
        // Compose through skill_create so the same proposal shape (+ commit
        // path) handles both extraction-driven creates and direct creates.
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
 *   | {ok: true, result: *}
 *   | {ok: true, result: *, pendingEdit: {op:string, path:string, oldValue:*, newValue:*}}
 *   | {ok: true, result: *, pendingSkillEdit: {kind:string, skillName:string, scope:object, path?:string, before:*, after:*, op:{name:string, args:object}}}
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
        if (out && typeof out === 'object' && 'pendingSkillEdit' in out) {
            return { ok: true, result: out.result, pendingSkillEdit: out.pendingSkillEdit };
        }
        return { ok: true, result: out };
    } catch (err) {
        return { ok: false, error: String(err?.message || err || 'unknown error') };
    }
}
