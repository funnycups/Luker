/**
 * loop-tools.js — central dispatcher for loop-mode tool calls.
 *
 * This module owns three things:
 *
 *   1. REGISTRY — a map of tool name → execution function. The runtime
 *      asks the dispatcher to invoke a tool by name; the dispatcher
 *      raises a structured `ToolError(NOT_IMPLEMENTED)` for unknown
 *      names so the agent sees the failure and self-corrects rather
 *      than aborting the whole run.
 *
 *   2. TOOL_SCHEMAS — the OpenAI-style function schemas the loop sends
 *      to the model. The always-on `finalize` schema is included here
 *      for a single source of truth: the runtime's `FINALIZE_TOOL_SCHEMA`
 *      is re-exported so loop-runtime can keep building it directly,
 *      while `getEnabledToolSchemas(profile)` does the profile-driven
 *      filtering for chat / lorebook / note / search tools.
 *
 *   3. `getEnabledToolSchemas(profile)` — derives the active schemas
 *      from `profile.tools.<namespace>.<verb>` flags. `finalize` is
 *      always emitted because the agent has no other terminator;
 *      everything else respects the profile flag.
 *
 * Task 8 introduces the dispatcher with chat tools wired in. Task 9
 * appends `lorebook_search` / `lorebook_get`. Task 11 adds
 * `note_open` / `note_close`. Memory + search tools live in Layer-2
 * — memory-graph and search-tools register their own through
 * `getExtensionApi('orchestrator').registerOrchestrationTool`.
 *
 * Tool names use `<namespace>_<verb>` (e.g. `chat_read_range`) because
 * Anthropic's tool-name regex `^[a-zA-Z0-9_-]{1,128}$` rejects dots.
 * The profile flag tree still nests as `tools.<ns>.<verb>` — only the
 * LLM-visible name is flat. See `createPersistentToolCallPayload` and
 * `executeLoopTool` for the legacy-`<ns>.<verb>` migration shim.
 */

import { FINALIZE_TOOL_SCHEMA, ToolError } from './loop-runtime.js';
import { getExtensionRegistry } from './register-custom-tool.js';
import { execChatReadRange, execChatSearch } from './loop-tools/chat.js';
import { execLorebookSearch, execLorebookGet, execWorldBookList, execLorebookList } from './loop-tools/lorebook.js';
import { execLorebookForceActivate } from './loop-tools/lorebook-force-activate.js';
import { execNoteOpen, execNoteClose } from './loop-tools/note.js';

/**
 * Map of fully-qualified tool name → async execution function.
 * Each implementation receives `(args, context)` and returns a JSON-
 * serializable result (or throws `ToolError` on user-facing failures).
 */
const REGISTRY = new Map();

/**
 * Layer-3 customToolRegistry shape gate. The per-run registry must be
 * Map-shaped: support `.get(name)` for dispatch AND iteration of
 * `[name, entry]` pairs for schema merge. Both `executeLoopTool` and
 * `getEnabledToolSchemas` use this identically so Layer-3 acceptance
 * is symmetric.
 */
function isToolRegistry(reg) {
    return reg != null
        && typeof reg.get === 'function'
        && typeof reg[Symbol.iterator] === 'function';
}

/**
 * Array of OpenAI-style tool schemas (each shaped as
 * `{ type: 'function', function: { name, description, parameters } }`).
 * `getEnabledToolSchemas` filters this list per profile.
 */
const TOOL_SCHEMAS = [];

// ---------------------------------------------------------------------------
// Simulation state
//
// When a workbench simulation runs, the module-level `simulationActive`
// flag gates write-mode tool dispatch in `executeLoopTool` so model-driven
// tool calls produce no real side effects (no memory-graph mutations, no
// notes floor-state writes, no future side-effecting tools). Read tools
// stay live — the agent must see real current state to make meaningful
// decisions.
//
// Begin/end is intentionally a flat flag (not a stack). Simulations are
// modal popup-blocking; a second sim cannot start until the first
// resolves. Nested begin throws to expose a caller bug rather than mask
// it as a silent stack-pop later.
// ---------------------------------------------------------------------------
let simulationActive = false;
let simulationRunId = null;

export function beginSimulation(runId) {
    if (simulationActive) {
        throw new Error(`[loop-tools] Simulation already active: ${simulationRunId}`);
    }
    simulationActive = true;
    simulationRunId = typeof runId === 'string' && runId ? runId : '(unnamed)';
}

export function endSimulation() {
    simulationActive = false;
    simulationRunId = null;
}

export function isSimulationActive() {
    return simulationActive;
}

/** Internal: register a tool, its schema, and its mode in one shot. */
function registerTool(name, exec, schema, opts = {}) {
    if (typeof exec !== 'function') {
        throw new Error(`[loop-tools] cannot register '${name}': exec must be a function.`);
    }
    let mode = opts.mode;
    if (mode !== 'read' && mode !== 'write') {
        console.warn(`[loop-tools] '${name}' missing or invalid mode; defaulting to 'write'.`);
        mode = 'write';
    }
    REGISTRY.set(name, { exec, mode, simulate: typeof opts.simulate === 'function' ? opts.simulate : null });
    if (schema) TOOL_SCHEMAS.push(schema);
}

// ---- chat namespace ------------------------------------------------------

registerTool('chat_read_range', execChatReadRange, {
    type: 'function',
    function: {
        name: 'chat_read_range',
        description: 'Read a contiguous range of chat floors. Negative indices count from the end (e.g. start=-5, end=-1 reads the last 5 floors). Maximum 50 floors per call.',
        parameters: {
            type: 'object',
            properties: {
                start: {
                    type: 'integer',
                    description: 'First floor to include (inclusive). Negative counts from end.',
                },
                end: {
                    type: 'integer',
                    description: 'Last floor to include (inclusive). Negative counts from end.',
                },
            },
            required: ['start', 'end'],
            additionalProperties: false,
        },
    },
}, { mode: 'read' });

registerTool('chat_search', execChatSearch, {
    type: 'function',
    function: {
        name: 'chat_search',
        description: 'Regex search across all chat floors. Returns grep -n style output: one matched line per result as "floor_{N} [{role}]:{lineno}: {line_content}". Use chat_read_range to read full content for a specific floor.',
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'JavaScript RegExp source. Match literal text by escaping metacharacters (e.g. \\. \\[ \\( \\\\). Prefer non-greedy quantifiers (.*? \\w+?) by default; switch to greedy only when you genuinely need the longest match — greedy can blow up on large corpora.',
                },
                flags: {
                    type: 'string',
                    description: "RegExp flags. 'gm' by default (global + multiline). Add 'i' for case-insensitive. 'g' is auto-injected if you omit it.",
                    default: 'gm',
                },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
    },
}, { mode: 'read' });

// ---- lorebook namespace -------------------------------------------------

registerTool('lorebook_search', execLorebookSearch, {
    type: 'function',
    function: {
        name: 'lorebook_search',
        description: 'Regex search across all enabled lorebook entries (World Info). Excludes entries already activated this turn so the agent does not rediscover what main-flow World Info already injected. Returns grep -n style output: one matched line per result as "[{book}] {entry_name}:{lineno}: {line_content}".',
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'JavaScript RegExp source. Match literal text by escaping metacharacters (e.g. \\. \\[ \\( \\\\). Prefer non-greedy quantifiers (.*? \\w+?) by default.',
                },
                flags: {
                    type: 'string',
                    description: "RegExp flags. 'gm' by default. 'g' is auto-injected if you omit it.",
                    default: 'gm',
                },
                book: {
                    type: 'string',
                    description: 'Optional: narrow by lorebook name (entry.world). All enabled books are scanned if omitted.',
                },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
    },
}, { mode: 'read' });

registerTool('lorebook_get', execLorebookGet, {
    type: 'function',
    function: {
        name: 'lorebook_get',
        description: 'Fetch one lorebook entry, addressed by uid OR entry_key (pass exactly one). Returns {book, uid, name, key, content}. Does NOT dedup against activated entries — use this when you need the structured view of an entry already in your context.',
        parameters: {
            type: 'object',
            properties: {
                entry_key: {
                    type: 'string',
                    description: 'Exact key string (case-sensitive) appearing in the entry\'s key array. Mutually exclusive with uid.',
                },
                uid: {
                    type: 'integer',
                    description: 'Stable numeric handle from lorebook_list output. Mutually exclusive with entry_key.',
                },
                book: {
                    type: 'string',
                    description: 'Optional: narrow by lorebook name (entry.world). First match wins if omitted.',
                },
            },
            additionalProperties: false,
        },
    },
}, { mode: 'read' });

registerTool('world_book_list', execWorldBookList, {
    type: 'function',
    function: {
        name: 'world_book_list',
        description: 'List world books visible to this chat. Returns grep-style lines: "[{scope}] {book_name} ({n} entries)". Use this first to discover which book names exist before calling lorebook_list or lorebook_get with a book filter.',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
}, { mode: 'read' });

registerTool('lorebook_list', execLorebookList, {
    type: 'function',
    function: {
        name: 'lorebook_list',
        description: 'List entry index rows for one world book. Returns grep-style lines: "[{book}] uid={n} name={comment} key={k1|k2|...}". Skips entries the main flow already injected this turn. Use lorebook_get to read full content for a specific uid or key.',
        parameters: {
            type: 'object',
            properties: {
                book_name: {
                    type: 'string',
                    description: 'Required. Target world book name (entry.world). Call world_book_list to discover available books.',
                },
                range: {
                    type: 'string',
                    description: 'Optional inclusive uid window: "0~100", "50~", "~100", or a single uid like "42".',
                },
            },
            required: ['book_name'],
            additionalProperties: false,
        },
    },
}, { mode: 'read' });

registerTool('lorebook_force_activate', execLorebookForceActivate, {
    type: 'function',
    function: {
        name: 'lorebook_force_activate',
        description: 'Force one or more dormant lorebook entries into the main model\'s <world_info> channel for THIS turn. The entries land in the same channel as naturally-activated entries — the model cannot tell them apart. Use sparingly: forced entries BYPASS the World Info token budget, so pushing too much will silently evict chat history. They also do NOT trigger recursive key scanning. Use lorebook_list to discover dormant uids first; constant:true entries do not need forcing. Works in loop / spec / agenda — those modes share the GENERATION_WORLD_INFO_FINALIZED frame with the WI payload. Returns LOREBOOK_FORCE_NO_PAYLOAD in director mode (director\'s main agent runs after WI is baked into the prompt; force-activation is too late). In spec, sibling nodes that already ran in the same turn will NOT see your forced entries — only the final main-model generation does. Returns {ok, book, activated:[{uid, comment, route, chars}], skipped:[{uid, reason}]}.',
        parameters: {
            type: 'object',
            properties: {
                book_name: {
                    type: 'string',
                    description: 'Required. Target world book name (entry.world). Get from world_book_list / lorebook_list output.',
                },
                uids: {
                    type: 'array',
                    items: { type: 'integer' },
                    description: 'Required. Non-empty array of uids to force-activate. Stable handles from lorebook_list output.',
                },
            },
            required: ['book_name', 'uids'],
            additionalProperties: false,
        },
    },
}, { mode: 'write' });

// ---- note namespace -----------------------------------------------------

registerTool('note_open', execNoteOpen, {
    type: 'function',
    function: {
        name: 'note_open',
        description: 'Open a new plot-author note (foreshadowing, promise, chapter outline). Returns its id. The note shows up in your "## Open Notes" block until you close it.',
        parameters: {
            type: 'object',
            properties: {
                text: {
                    type: 'string',
                    description: 'The note content. Short or long; max 16KB UTF-8.',
                },
            },
            required: ['text'],
            additionalProperties: false,
        },
    },
}, { mode: 'write' });

registerTool('note_close', execNoteClose, {
    type: 'function',
    function: {
        name: 'note_close',
        description: 'Close an open note by id (e.g. it has been deployed or is no longer needed). Optional one-line reason.',
        parameters: {
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    description: 'The note id visible in the Open Notes block.',
                },
                reason: {
                    type: 'string',
                    description: 'Optional one-line closure reason.',
                },
            },
            required: ['id'],
            additionalProperties: false,
        },
    },
}, { mode: 'write' });

// ---- public API ----------------------------------------------------------

/**
 * Re-export of the runtime's finalize schema so dispatcher consumers have
 * a single import surface for "all loop tool schemas".
 */
export { FINALIZE_TOOL_SCHEMA };

/**
 * Dispatch a loop tool call by name. The runtime catches `ToolError`
 * and re-injects the structured failure into the messages array;
 * unknown tools surface as `ToolError(NOT_IMPLEMENTED)` so the agent
 * can pivot rather than the whole run aborting.
 *
 * @param {string} name — fully qualified tool name (e.g. 'chat_search').
 *                        Legacy `chat.search` names from pre-rename
 *                        persisted history are normalized to `_` form
 *                        before dispatch so old chats keep replaying.
 * @param {object} args — tool arguments
 * @param {object} context — extension context (chat, run-scoped state)
 * @returns {Promise<unknown>} JSON-serializable result for the tool message
 */
export async function executeLoopTool(name, args, context) {
    const normalized = String(name || '').replace(/\./g, '_');
    const safeCtx = context || {};
    const safeArgs = args && typeof args === 'object' ? args : {};

    const perRunReg = safeCtx.__customToolRegistry;
    let entry = isToolRegistry(perRunReg) ? perRunReg.get(normalized) : null;
    if (!entry) entry = REGISTRY.get(normalized) || null;
    if (!entry) entry = getExtensionRegistry().get(normalized) || null;

    if (!entry || typeof entry.exec !== 'function') {
        throw new ToolError(
            `Tool '${name}' is not implemented in this build.`,
            'NOT_IMPLEMENTED',
            'Pick a registered tool name or call finalize when you have enough information.',
        );
    }

    if (simulationActive && entry.mode === 'write') {
        try {
            if (typeof entry.simulate === 'function') {
                return await entry.simulate(safeArgs, safeCtx);
            }
            return { ok: true, simulated: true, unvalidated: true };
        } catch (err) {
            return { ok: false, simulated: true, error: String(err?.message ?? err) };
        }
    }

    return entry.exec(safeArgs, safeCtx);
}

/**
 * Build the OpenAI-style tools array from a sanitized loop profile.
 * `finalize` is always included; chat / lorebook / note tools follow
 * `profile.tools.<namespace>.<verb>` flags. The schema's flat
 * `<ns>_<verb>` tool name is split on the **first** underscore to
 * recover the profile path (so `chat_read_range` reads
 * `flags.chat.read_range`). Unknown namespaces are ignored
 * (forward compatibility with future task adds).
 */
export function getEnabledToolSchemas(profile, customToolRegistry = null) {
    const flags = profile && typeof profile === 'object' ? (profile.tools || {}) : {};
    const out = [FINALIZE_TOOL_SCHEMA];

    for (const schema of TOOL_SCHEMAS) {
        const fullName = String(schema?.function?.name || '');
        if (!fullName) continue;
        // Special case: world_book_list lives under the lorebook flag bag
        // even though its name does not start with `lorebook_`. The
        // first-underscore split would route it to flags.world.book_list,
        // which would never be set.
        if (fullName === 'world_book_list') {
            if (flags?.lorebook?.world_book_list) out.push(schema);
            continue;
        }
        const sep = fullName.indexOf('_');
        if (sep < 0) {
            if (flags?.[fullName]) out.push(schema);
            continue;
        }
        const ns = fullName.slice(0, sep);
        const verb = fullName.slice(sep + 1);
        if (flags?.[ns]?.[verb]) out.push(schema);
    }

    const customFlags = (flags && typeof flags.custom === 'object') ? flags.custom : {};
    const seen = new Set();

    if (isToolRegistry(customToolRegistry)) {
        for (const [name, entry] of customToolRegistry) {
            seen.add(name);
            if (customFlags[name] !== false) out.push(entry.schema);
        }
    }

    for (const [name, entry] of getExtensionRegistry()) {
        if (seen.has(name)) continue;
        if (customFlags[name] !== false) out.push(entry.schema);
    }

    return out;
}

/**
 * Returns the live Layer-1 builtin tool registry. Used at runtime by other
 * layers (e.g. register-custom-tool's collision check, main.js's
 * builtin-name set) and by tests for setup.
 */
export function getBuiltinToolRegistry() {
    return REGISTRY;
}

/**
 * Resolve a tool's source layer by name + per-call context. Mirrors the
 * lookup order used by `executeLoopTool` (Layer-3 → Layer-1 → Layer-2) so
 * the source label reflects the registry that would actually serve the
 * dispatch. Used by the runtimes to tag `tool_call` trace entries — the
 * simulation-review popup then renders a chip for non-builtin tools.
 *
 *   - 'profile'   — per-run Layer-3 customTools[] entry (`ctx.__customToolRegistry`)
 *   - 'builtin'   — Layer-1 entry registered via `registerTool` above
 *   - 'st-bridge' — Layer-2 ST-bridged tool (`source: 'st-bridge'` on the entry)
 *   - 'extension' — Layer-2 extension-registered tool (anything else in the
 *                    extension registry)
 *   - 'unknown'   — name not found in any registry
 */
export function resolveToolSource(name, context) {
    const normalized = String(name || '').replace(/\./g, '_');
    const safeCtx = context || {};
    const perRunReg = safeCtx.__customToolRegistry;
    if (perRunReg && typeof perRunReg.get === 'function' && perRunReg.get(normalized)) return 'profile';
    if (REGISTRY.has(normalized)) return 'builtin';
    const extEntry = getExtensionRegistry().get(normalized);
    if (extEntry) {
        return extEntry.source === 'st-bridge' ? 'st-bridge' : 'extension';
    }
    return 'unknown';
}

/** @internal — alias retained for existing test files. */
export const __getRegistryForTest = getBuiltinToolRegistry;

/**
 * @internal — exposed for tests. Returns the live TOOL_SCHEMAS array
 * (excluding finalize, which the runtime owns directly).
 */
export function __getSchemasForTest() {
    return TOOL_SCHEMAS;
}
