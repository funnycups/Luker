// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Orchestrator custom-tool iter-studio — tool defs + per-call executor +
 * Apply-time commit helper that lets the iter-studio AI author / edit /
 * remove `profile.customTools[]` entries through the same per-card user
 * review pipeline that lorebook + skill writes already use.
 *
 * Tool catalog (11 tools):
 *   READS (no proposals, results returned verbatim):
 *     luker_orch_list_custom_tools     — list profile-owned entries
 *     luker_orch_get_custom_tool       — read one entry verbatim
 *     luker_orch_dry_run_custom_tool   — compile + run a body in a sandbox
 *                                        with caller-supplied args; full
 *                                        exception relayed back; 3s wall-
 *                                        clock cap; console.log captured
 *     luker_ctx_list_keys              — top-level ctx keys (lifted)
 *     luker_ctx_describe               — describe one ctx path (lifted)
 *     luker_docs_list                  — list docs/*.md
 *     luker_docs_read                  — read one doc file
 *   WRITES (return {pendingCustomToolEdit} the popup parks on ProposalBus):
 *     luker_orch_set_custom_tool             — kind: 'upsert'
 *     luker_orch_patch_custom_tool_body      — kind: 'patch_body'
 *     luker_orch_patch_custom_tool_schema    — kind: 'patch_schema'
 *     luker_orch_remove_custom_tool          — kind: 'remove'
 *
 * Proposal contract mirrors skill-iter-studio's `pendingSkillEdit` envelope
 * verbatim (one blob per tool call, parked on ProposalBus, committed via
 * `commitApprovedCustomToolProposal`). Bodies are compile-validated at
 * proposal time so the AI gets a real SyntaxError back, not a silent ok.
 */

import { sanitizeCustomTools } from './custom-tools-sanitize.js';
import { applyStringPatch } from './system-prompt-patch.js';
import { getBuiltinToolRegistry } from './loop-tools.js';
import {
    listCtxKeys,
    describeCtxPath,
    listLukerDocs,
    readLukerDoc,
} from '../../iteration-library/tools/ctx-and-docs-discovery.js';

const AsyncFunction = (async () => {}).constructor;
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const DRY_RUN_TIMEOUT_MS = 3000;

// ────────────────────────────────────────────────────────────────────────────
// Tool name constants — exported for the studio.js dispatch shim and for
// the test files that assert prompt content.
// ────────────────────────────────────────────────────────────────────────────

export const CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES = Object.freeze({
    LIST: 'luker_orch_list_custom_tools',
    GET: 'luker_orch_get_custom_tool',
    SET: 'luker_orch_set_custom_tool',
    PATCH_BODY: 'luker_orch_patch_custom_tool_body',
    PATCH_SCHEMA: 'luker_orch_patch_custom_tool_schema',
    REMOVE: 'luker_orch_remove_custom_tool',
    DRY_RUN: 'luker_orch_dry_run_custom_tool',
    CTX_LIST_KEYS: 'luker_ctx_list_keys',
    CTX_DESCRIBE: 'luker_ctx_describe',
    DOCS_LIST: 'luker_docs_list',
    DOCS_READ: 'luker_docs_read',
});

const CUSTOM_TOOL_ITER_STUDIO_TOOL_NAME_SET = new Set(Object.values(CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES));

export function isCustomToolIterStudioTool(name) {
    return CUSTOM_TOOL_ITER_STUDIO_TOOL_NAME_SET.has(String(name || ''));
}

// ────────────────────────────────────────────────────────────────────────────
// Tool schema definitions registered into the iter-studio tool set.
// ────────────────────────────────────────────────────────────────────────────

export const CUSTOM_TOOL_ITER_STUDIO_TOOL_DEFS = Object.freeze([
    {
        type: 'function',
        function: {
            name: CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.LIST,
            description: 'List the profile\'s handwritten custom tools — returns name, mode, description, hasSimulate, and a one-line parameter-schema summary. Use this BEFORE authoring to check what is already there and avoid name collisions.',
            parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.GET,
            description: 'Return one profile custom tool verbatim by name (body, simulateBody, parameters, description). Use this BEFORE editing so you can read the current code before patching.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Tool name (matches `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`)' },
                },
                required: ['name'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.SET,
            description: 'Create or overwrite one custom tool entry. Body is a JavaScript async function body — receives (args, ctx). The body is compile-validated immediately; a syntax error returns {ok:false}. On success the change is staged as a proposal and rendered as a review card; nothing reaches the profile until the user approves and clicks Apply. ALWAYS run luker_orch_dry_run_custom_tool first with realistic args so you catch runtime errors before staging.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Tool name (matches `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`). Must not collide with a Layer-1 builtin (e.g. `chat_search`, `lorebook_get`).' },
                    displayName: { type: 'string', description: 'Optional human-readable label.' },
                    description: { type: 'string', description: 'Required. What the tool does, written for the runtime agent that will call it.' },
                    mode: { type: 'string', enum: ['read', 'write'], description: 'read = no side effects (safe to call in simulation); write = mutates state.' },
                    parameters: { type: 'object', description: 'OpenAI-style JSON Schema describing the runtime agent\'s arguments to this tool.' },
                    body: { type: 'string', description: 'JavaScript async function body. `args` is the runtime agent\'s parsed call payload; `ctx` is the same object SillyTavern/Luker extensions get via getContext(), augmented with orchestration-specific fields (see ctx.director?.getDraft, ctx.__customToolRegistry). Use luker_ctx_describe + luker_docs_read FIRST to learn the actual surface.' },
                    simulateBody: { type: 'string', description: 'Optional. Body used when running in simulation review. Write-mode tools without a simulate body return a placeholder during simulation.' },
                },
                required: ['name', 'description', 'mode', 'parameters', 'body'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.PATCH_BODY,
            description: 'Find/replace patch on an existing custom tool\'s body without resending the whole body. Default `oldString` must occur exactly once — widen with surrounding context until unique. Pass `replaceAll: true` to replace every occurrence. Patched body is compile-validated; syntax errors return {ok:false}. Prefer this over luker_orch_set_custom_tool when only tweaking a few lines.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    oldString: { type: 'string', description: 'Substring to find. Must occur exactly once unless replaceAll is true.' },
                    newString: { type: 'string', description: 'Replacement text. Use "" to delete.' },
                    replaceAll: { type: 'boolean', description: 'Optional. When true, replace every occurrence. Default false.' },
                    target: { type: 'string', enum: ['body', 'simulateBody'], description: 'Optional. Which body to patch. Default "body".' },
                },
                required: ['name', 'oldString', 'newString'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.PATCH_SCHEMA,
            description: 'Replace just the parameters JSON-Schema on an existing custom tool. The body stays as-is. Use this when you only need to add/remove/rename a parameter, not when you also need to update the body.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    parameters: { type: 'object', description: 'New OpenAI-style JSON Schema for the tool arguments.' },
                },
                required: ['name', 'parameters'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.REMOVE,
            description: 'Delete one custom tool from the profile by name. Staged as a proposal; the user sees the body that will be deleted before approving.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                },
                required: ['name'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.DRY_RUN,
            description: 'Compile + execute a custom tool body in a sandbox with caller-supplied args. NO profile mutation. Either `name` (run the live profile entry) or `body` (compile + run inline) is required. Returns {ok, result?, error?, logs, durationMs}. Console.log/warn/error calls inside the body are captured into `logs`. Wall-clock cap is 3 seconds. ALWAYS run this with realistic args before staging a write proposal so the user does not have to approve a body you have not validated against the live ctx.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Existing profile tool name to dry-run. Mutually exclusive with `body`.' },
                    body: { type: 'string', description: 'Inline JavaScript async function body to dry-run. Mutually exclusive with `name`.' },
                    args: { type: 'object', description: 'Args object passed to the body as `args`. Should match the runtime agent\'s expected call shape.' },
                    useSimulateBody: { type: 'boolean', description: 'Optional. When true and `name` is given, run the simulate body instead of the production body. Default false.' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.CTX_LIST_KEYS,
            description: 'List top-level properties of the runtime ctx (the same object SillyTavern/Luker extensions get via getContext(), ~200+ keys). Each entry is {key, type}. Use luker_ctx_describe for details on a specific key.',
            parameters: {
                type: 'object',
                properties: {
                    filter: { type: 'string', description: 'Optional substring to match keys (case-insensitive).' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.CTX_DESCRIBE,
            description: 'Describe a property or nested path of the runtime ctx. Returns type, function arity hint + source preview for functions, sub-keys for objects, value for scalars. Supports dot paths like "presets.state.patch" or "chat".',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Dot path, e.g. "generate" or "presets.state.patch".' },
                },
                required: ['path'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.DOCS_LIST,
            description: 'List Luker documentation files (markdown) available locally. By default returns only English docs. Useful starting points: development/extension-api/orchestrator-tools.md, features/orchestrator/custom-tools.md, development/extension-api/chat-and-state.md, development/extension-api/generation.md, development/extension-api/world-info.md.',
            parameters: {
                type: 'object',
                properties: {
                    filter: { type: 'string', description: 'Optional substring to match file paths (case-insensitive).' },
                    includeTranslations: { type: 'boolean', description: 'Include zh-CN and zh-TW translation files. Default false; translations duplicate English content.' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.DOCS_READ,
            description: 'Read a Luker documentation markdown file. Use this to look up authoritative guidance on the ctx surface, orchestrator tool API, lorebook contracts, state-system, etc., BEFORE generating code that touches those areas.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Doc path relative to docs/, e.g. "development/extension-api/chat-and-state.md".' },
                },
                required: ['path'],
                additionalProperties: false,
            },
        },
    },
]);

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function summarizeSchema(parameters) {
    if (!parameters || typeof parameters !== 'object') return '(no params)';
    const props = parameters.properties && typeof parameters.properties === 'object' ? parameters.properties : null;
    if (!props) return '(no params)';
    const required = Array.isArray(parameters.required) ? new Set(parameters.required) : new Set();
    const keys = Object.keys(props);
    if (keys.length === 0) return '(no params)';
    const parts = keys.map(k => {
        const t = String(props[k]?.type || '*');
        return required.has(k) ? `${k}:${t}` : `${k}?:${t}`;
    });
    return parts.join(', ');
}

function validateBodyCompiles(body) {
    try {
        // eslint-disable-next-line no-new
        new AsyncFunction('args', 'ctx', String(body || ''));
        return { ok: true };
    } catch (err) {
        return { ok: false, error: `syntax: ${err?.message || err}` };
    }
}

function nameConflictsBuiltin(name) {
    try {
        return getBuiltinToolRegistry().has(name);
    } catch {
        return false;
    }
}

function findToolByName(profile, name) {
    const tools = Array.isArray(profile?.customTools) ? profile.customTools : [];
    return tools.find(t => String(t?.name || '') === String(name || '')) || null;
}

function serializeError(err) {
    if (err == null) return 'unknown error';
    if (typeof err === 'string') return err;
    const msg = String(err?.message || err);
    const stack = String(err?.stack || '');
    // Capture the first stack frame after the message for context.
    const firstFrame = stack.split('\n').slice(1).find(line => /\s+at\s+/.test(line));
    return firstFrame ? `${msg}\n${firstFrame.trim()}` : msg;
}

// ────────────────────────────────────────────────────────────────────────────
// Dry-run sandbox
// ────────────────────────────────────────────────────────────────────────────

async function dryRunBody({ body, args, ctxFactory }) {
    const compile = validateBodyCompiles(body);
    if (!compile.ok) {
        return { ok: false, error: compile.error, logs: [], durationMs: 0 };
    }
    let fn;
    try {
        // Construct with a third synthetic `console` parameter — shadows
        // the global so `console.log(...)` inside the body resolves to
        // our sandbox shim. The runtime production body sees only
        // (args, ctx); the dry-run path adds this extra arg solely to
        // capture printf-style debug output without polluting the page
        // console.
        fn = new AsyncFunction('args', 'ctx', 'console', String(body || ''));
    } catch (err) {
        return { ok: false, error: `compile: ${err?.message || err}`, logs: [], durationMs: 0 };
    }
    const logs = [];
    const sandboxConsole = {
        log:   (...a) => { logs.push({ level: 'log', message: a.map(stringifyArg).join(' ') }); },
        warn:  (...a) => { logs.push({ level: 'warn', message: a.map(stringifyArg).join(' ') }); },
        error: (...a) => { logs.push({ level: 'error', message: a.map(stringifyArg).join(' ') }); },
        info:  (...a) => { logs.push({ level: 'info', message: a.map(stringifyArg).join(' ') }); },
        debug: (...a) => { logs.push({ level: 'debug', message: a.map(stringifyArg).join(' ') }); },
    };
    const ctxSnapshot = ctxFactory({ console: sandboxConsole });
    const startedAt = performance && typeof performance.now === 'function' ? performance.now() : Date.now();
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`dry-run timeout (${DRY_RUN_TIMEOUT_MS}ms)`)), DRY_RUN_TIMEOUT_MS);
    });
    try {
        const result = await Promise.race([fn(args, ctxSnapshot, sandboxConsole), timeout]);
        clearTimeout(timer);
        const endedAt = performance && typeof performance.now === 'function' ? performance.now() : Date.now();
        return {
            ok: true,
            result: cloneForReply(result),
            logs,
            durationMs: Math.round(endedAt - startedAt),
        };
    } catch (err) {
        clearTimeout(timer);
        const endedAt = performance && typeof performance.now === 'function' ? performance.now() : Date.now();
        return {
            ok: false,
            error: serializeError(err),
            logs,
            durationMs: Math.round(endedAt - startedAt),
        };
    }
}

function stringifyArg(v) {
    if (v == null) return String(v);
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}

function cloneForReply(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return String(value);
    }
}

function defaultCtxFactory({ console: cons }) {
    // Real ctx the runtime would pass — getContext() returns the same
    // surface CardApp / orchestrator runtime use. Augment with the
    // sandbox console so dry-run logs surface without polluting the
    // page console.
    const ctx = Luker.getContext();
    return new Proxy(ctx, {
        get(target, prop) {
            if (prop === 'console') return cons;
            return target[prop];
        },
    });
}

// ────────────────────────────────────────────────────────────────────────────
// Per-call executor — dispatched by studio.js's per-mode iter executor.
//
// Returns one of:
//   - { ok: true, result }                           (read tool)
//   - { ok: true, result, pendingCustomToolEdit }    (write tool, staged)
//   - { ok: false, error: string }                   (validation / lookup failure)
//
// The studio.js dispatch shim parks `pendingCustomToolEdit` on
// ProposalBus and returns `result` to the AI as the tool reply.
// ────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} call             { name, args }
 * @param {object} opts
 * @param {object} opts.profile     The iter-studio's live working profile.
 *                                  Reads inspect it; writes derive `before`/`after`
 *                                  against a snapshot, never mutate it directly.
 * @param {Function} [opts.ctxFactory] Test seam — defaults to a real-ctx Proxy.
 * @returns {Promise<object>}
 */
export async function executeCustomToolIterStudioCall(call, { profile, ctxFactory = defaultCtxFactory } = {}) {
    const name = String(call?.name || '');
    const args = (call?.args && typeof call.args === 'object') ? call.args : {};
    if (!isCustomToolIterStudioTool(name)) {
        return { ok: false, error: `not a custom-tool iter-studio tool: ${name}` };
    }
    switch (name) {
        case CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.LIST: {
            const tools = Array.isArray(profile?.customTools) ? profile.customTools : [];
            return {
                ok: true,
                result: {
                    count: tools.length,
                    tools: tools.map(t => ({
                        name: String(t?.name || ''),
                        displayName: String(t?.displayName || ''),
                        mode: t?.mode === 'read' ? 'read' : 'write',
                        description: String(t?.description || ''),
                        hasSimulate: !!String(t?.simulateBody || ''),
                        paramSchemaSummary: summarizeSchema(t?.parameters),
                        bodyLength: (t?.body || '').length,
                    })),
                },
            };
        }
        case CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.GET: {
            const targetName = String(args.name || '');
            if (!NAME_PATTERN.test(targetName)) {
                return { ok: false, error: `invalid name "${targetName}" (must match ^[a-zA-Z][a-zA-Z0-9_]{0,63}$)` };
            }
            const tool = findToolByName(profile, targetName);
            if (!tool) {
                return { ok: false, error: `custom tool "${targetName}" not found on this profile` };
            }
            return {
                ok: true,
                result: {
                    name: tool.name,
                    displayName: tool.displayName || '',
                    description: tool.description || '',
                    mode: tool.mode === 'read' ? 'read' : 'write',
                    parameters: tool.parameters || { type: 'object' },
                    body: tool.body || '',
                    simulateBody: tool.simulateBody || '',
                },
            };
        }
        case CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.SET: {
            return handleSet(profile, args);
        }
        case CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.PATCH_BODY: {
            return handlePatchBody(profile, args);
        }
        case CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.PATCH_SCHEMA: {
            return handlePatchSchema(profile, args);
        }
        case CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.REMOVE: {
            return handleRemove(profile, args);
        }
        case CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.DRY_RUN: {
            return handleDryRun(profile, args, ctxFactory);
        }
        case CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.CTX_LIST_KEYS: {
            const result = await listCtxKeys({ filter: String(args?.filter || '') });
            return result?.ok ? { ok: true, result } : { ok: false, error: String(result?.error || 'ctx list failed') };
        }
        case CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.CTX_DESCRIBE: {
            const result = await describeCtxPath({ path: String(args?.path || '') });
            return result?.ok ? { ok: true, result } : { ok: false, error: String(result?.error || 'ctx describe failed') };
        }
        case CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.DOCS_LIST: {
            const result = await listLukerDocs({
                filter: String(args?.filter || ''),
                includeTranslations: !!args?.includeTranslations,
            });
            return result?.ok ? { ok: true, result } : { ok: false, error: String(result?.error || 'docs list failed') };
        }
        case CUSTOM_TOOL_ITER_STUDIO_TOOL_NAMES.DOCS_READ: {
            const result = await readLukerDoc({ path: String(args?.path || '') });
            return result?.ok ? { ok: true, result } : { ok: false, error: String(result?.error || 'docs read failed') };
        }
        default:
            return { ok: false, error: `unhandled custom-tool iter-studio tool: ${name}` };
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Write handlers — return {ok, result, pendingCustomToolEdit}
// ────────────────────────────────────────────────────────────────────────────

function buildProposalAck({ kind, name }) {
    return {
        ok: true,
        proposed: true,
        kind,
        tool: name,
        message: 'Proposed for user approval. The change is NOT live yet — the user reviews this diff card and approves or rejects it; nothing reaches the profile until the user clicks Apply. The iter-studio will PAUSE the auto-continue loop the moment any write proposal is staged: the next round will not fire until the user has resolved every pending card. You will then receive a synthetic user message describing exactly which proposals committed and which were rejected.',
    };
}

function handleSet(profile, args) {
    const name = String(args.name || '');
    if (!NAME_PATTERN.test(name)) {
        return { ok: false, error: `invalid name "${name}" (must match ^[a-zA-Z][a-zA-Z0-9_]{0,63}$)` };
    }
    if (nameConflictsBuiltin(name)) {
        return { ok: false, error: `name "${name}" conflicts with a Layer-1 builtin tool; pick a different name` };
    }
    const mode = args.mode === 'read' ? 'read' : (args.mode === 'write' ? 'write' : null);
    if (mode === null) {
        return { ok: false, error: 'mode must be "read" or "write"' };
    }
    const description = typeof args.description === 'string' ? args.description : '';
    if (!description.trim()) {
        return { ok: false, error: 'description is required (the runtime agent reads it to decide whether to call this tool)' };
    }
    const parameters = args.parameters && typeof args.parameters === 'object' && !Array.isArray(args.parameters)
        ? args.parameters
        : null;
    if (!parameters) {
        return { ok: false, error: 'parameters must be a JSON-Schema object (use {"type":"object","properties":{}} for no-args tools)' };
    }
    const body = String(args.body || '');
    const bodyCheck = validateBodyCompiles(body);
    if (!bodyCheck.ok) {
        return { ok: false, error: `body ${bodyCheck.error}` };
    }
    const simulateBody = typeof args.simulateBody === 'string' ? args.simulateBody : '';
    if (simulateBody) {
        const simCheck = validateBodyCompiles(simulateBody);
        if (!simCheck.ok) {
            return { ok: false, error: `simulateBody ${simCheck.error}` };
        }
    }
    const displayName = typeof args.displayName === 'string' ? args.displayName : '';
    const before = findToolByName(profile, name);
    const after = {
        name,
        displayName,
        description,
        mode,
        parameters,
        body,
        simulateBody,
    };
    return {
        ok: true,
        result: buildProposalAck({ kind: before ? 'upsert(overwrite)' : 'upsert(create)', name }),
        pendingCustomToolEdit: {
            kind: 'upsert',
            name,
            before: before ? cloneToolEntry(before) : null,
            after,
            op: { name: 'luker_orch_set_custom_tool', args: { ...args } },
        },
    };
}

function handlePatchBody(profile, args) {
    const name = String(args.name || '');
    if (!NAME_PATTERN.test(name)) {
        return { ok: false, error: `invalid name "${name}"` };
    }
    const before = findToolByName(profile, name);
    if (!before) {
        return { ok: false, error: `custom tool "${name}" not found on this profile` };
    }
    const target = args.target === 'simulateBody' ? 'simulateBody' : 'body';
    const currentText = String(before?.[target] || '');
    const patch = applyStringPatch(currentText, {
        oldString: typeof args.oldString === 'string' ? args.oldString : '',
        newString: typeof args.newString === 'string' ? args.newString : '',
        replaceAll: !!args.replaceAll,
    });
    if (!patch.ok) {
        return { ok: false, error: `patch ${patch.error}: ${patch.detail || ''}` };
    }
    const nextText = patch.nextText;
    const bodyCheck = validateBodyCompiles(nextText);
    if (!bodyCheck.ok) {
        return { ok: false, error: `patched ${target} ${bodyCheck.error}` };
    }
    const after = { ...cloneToolEntry(before), [target]: nextText };
    return {
        ok: true,
        result: buildProposalAck({ kind: `patch_body(${target})`, name }),
        pendingCustomToolEdit: {
            kind: 'patch_body',
            name,
            before: cloneToolEntry(before),
            after,
            op: { name: 'luker_orch_patch_custom_tool_body', args: { ...args } },
        },
    };
}

function handlePatchSchema(profile, args) {
    const name = String(args.name || '');
    if (!NAME_PATTERN.test(name)) {
        return { ok: false, error: `invalid name "${name}"` };
    }
    const before = findToolByName(profile, name);
    if (!before) {
        return { ok: false, error: `custom tool "${name}" not found on this profile` };
    }
    const parameters = args.parameters && typeof args.parameters === 'object' && !Array.isArray(args.parameters)
        ? args.parameters
        : null;
    if (!parameters) {
        return { ok: false, error: 'parameters must be a JSON-Schema object' };
    }
    const after = { ...cloneToolEntry(before), parameters };
    return {
        ok: true,
        result: buildProposalAck({ kind: 'patch_schema', name }),
        pendingCustomToolEdit: {
            kind: 'patch_schema',
            name,
            before: cloneToolEntry(before),
            after,
            op: { name: 'luker_orch_patch_custom_tool_schema', args: { ...args } },
        },
    };
}

function handleRemove(profile, args) {
    const name = String(args.name || '');
    if (!NAME_PATTERN.test(name)) {
        return { ok: false, error: `invalid name "${name}"` };
    }
    const before = findToolByName(profile, name);
    if (!before) {
        return { ok: false, error: `custom tool "${name}" not found on this profile` };
    }
    return {
        ok: true,
        result: buildProposalAck({ kind: 'remove', name }),
        pendingCustomToolEdit: {
            kind: 'remove',
            name,
            before: cloneToolEntry(before),
            after: null,
            op: { name: 'luker_orch_remove_custom_tool', args: { ...args } },
        },
    };
}

async function handleDryRun(profile, args, ctxFactory) {
    const sourceName = typeof args.name === 'string' ? args.name : '';
    const inlineBody = typeof args.body === 'string' ? args.body : '';
    if (!sourceName && !inlineBody) {
        return { ok: false, error: 'either `name` (existing profile tool) or `body` (inline JS) is required' };
    }
    if (sourceName && inlineBody) {
        return { ok: false, error: '`name` and `body` are mutually exclusive — pass one' };
    }
    const useSimulate = !!args.useSimulateBody;
    let body;
    let resolvedName;
    if (sourceName) {
        const tool = findToolByName(profile, sourceName);
        if (!tool) {
            return { ok: false, error: `custom tool "${sourceName}" not found on this profile` };
        }
        body = String((useSimulate ? tool.simulateBody : tool.body) || '');
        resolvedName = sourceName;
        if (!body.trim()) {
            return { ok: false, error: `tool "${sourceName}" has no ${useSimulate ? 'simulate body' : 'body'} to run` };
        }
    } else {
        body = inlineBody;
        resolvedName = '(inline)';
    }
    const runArgs = (args.args && typeof args.args === 'object' && !Array.isArray(args.args)) ? args.args : {};
    const outcome = await dryRunBody({ body, args: runArgs, ctxFactory });
    return {
        ok: true,
        result: {
            tool: resolvedName,
            dryRun: outcome,
        },
    };
}

function cloneToolEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    return {
        name: String(entry.name || ''),
        displayName: String(entry.displayName || ''),
        description: String(entry.description || ''),
        mode: entry.mode === 'read' ? 'read' : 'write',
        parameters: entry.parameters && typeof entry.parameters === 'object' ? entry.parameters : { type: 'object' },
        body: String(entry.body || ''),
        simulateBody: String(entry.simulateBody || ''),
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Apply-time committer — studio.js calls this per approved proposal blob.
//
// `op` is the original tool-call envelope captured at proposal time. We
// replay it against `profile.customTools[]` so concurrent drift (e.g. a
// parallel session deleted the tool we were about to patch) surfaces as
// an error here instead of clobbering with a stale snapshot.
//
// The profile mutation is in-place — studio.js's caller persists +
// sanitizes immediately after.
//
// `flagBucket` is the mode-appropriate enable-flag bucket
// (loop/director: profile.tools.custom; agenda: profile.defaultTools.custom;
// spec: profile.spec.defaultTools.custom). On upsert we flip the flag to
// true so the new tool is immediately offered to the runtime agent.
// ────────────────────────────────────────────────────────────────────────────

export function commitApprovedCustomToolProposal(profile, flagBucket, op) {
    if (!op || typeof op !== 'object' || !op.name) {
        throw new Error('commitApprovedCustomToolProposal: invalid op');
    }
    if (!profile || typeof profile !== 'object') {
        throw new Error('commitApprovedCustomToolProposal: profile must be an object');
    }
    if (!Array.isArray(profile.customTools)) {
        profile.customTools = [];
    }
    if (!flagBucket || typeof flagBucket !== 'object') {
        // Tolerate missing flag bucket — sanitizer will repair on the next
        // round-trip. Just no-op the flip.
        flagBucket = {};
    }
    const args = op.args && typeof op.args === 'object' ? op.args : {};
    const name = String(args.name || '');
    switch (op.name) {
        case 'luker_orch_set_custom_tool': {
            const incoming = {
                name,
                displayName: String(args.displayName || ''),
                description: String(args.description || ''),
                mode: args.mode === 'read' ? 'read' : 'write',
                parameters: args.parameters && typeof args.parameters === 'object' ? args.parameters : { type: 'object' },
                body: String(args.body || ''),
                simulateBody: String(args.simulateBody || ''),
            };
            const idx = profile.customTools.findIndex(t => String(t?.name || '') === name);
            if (idx >= 0) {
                profile.customTools[idx] = incoming;
            } else {
                profile.customTools.push(incoming);
            }
            flagBucket[name] = true;
            return { kind: 'upsert', name };
        }
        case 'luker_orch_patch_custom_tool_body': {
            const idx = profile.customTools.findIndex(t => String(t?.name || '') === name);
            if (idx < 0) {
                throw new Error(`patch_body commit: tool "${name}" no longer present`);
            }
            const current = profile.customTools[idx];
            const target = args.target === 'simulateBody' ? 'simulateBody' : 'body';
            const patch = applyStringPatch(String(current[target] || ''), {
                oldString: typeof args.oldString === 'string' ? args.oldString : '',
                newString: typeof args.newString === 'string' ? args.newString : '',
                replaceAll: !!args.replaceAll,
            });
            if (!patch.ok) {
                throw new Error(`patch_body commit: ${patch.error}: ${patch.detail || ''} (drift?)`);
            }
            profile.customTools[idx] = { ...current, [target]: patch.nextText };
            return { kind: 'patch_body', name };
        }
        case 'luker_orch_patch_custom_tool_schema': {
            const idx = profile.customTools.findIndex(t => String(t?.name || '') === name);
            if (idx < 0) {
                throw new Error(`patch_schema commit: tool "${name}" no longer present`);
            }
            const current = profile.customTools[idx];
            const parameters = args.parameters && typeof args.parameters === 'object' ? args.parameters : { type: 'object' };
            profile.customTools[idx] = { ...current, parameters };
            return { kind: 'patch_schema', name };
        }
        case 'luker_orch_remove_custom_tool': {
            const idx = profile.customTools.findIndex(t => String(t?.name || '') === name);
            if (idx < 0) {
                // Already gone — treat as a no-op rather than throwing, so a
                // double-approve doesn't error out.
                return { kind: 'remove', name, noop: true };
            }
            profile.customTools.splice(idx, 1);
            if (name in flagBucket) delete flagBucket[name];
            return { kind: 'remove', name };
        }
        default:
            throw new Error(`commitApprovedCustomToolProposal: unknown op ${op.name}`);
    }
}

/**
 * Final pass — run the in-place mutated profile.customTools[] through the
 * shared sanitizer to clamp lengths, drop malformed entries, and normalize
 * mode strings. Same call the import path makes.
 */
export function resanitizeProfileCustomTools(profile) {
    if (!profile || typeof profile !== 'object') return;
    profile.customTools = sanitizeCustomTools(profile.customTools);
}
