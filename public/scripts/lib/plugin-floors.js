/**
 * plugin-floors.js — chat floor accessor for plugin-driven LLM requests.
 *
 * Role in the regex lane-semantics refactor:
 *   Plugins (orchestrator agents, memory-graph, iter-studio, ...) need
 *   the chat history as prompt messages. Before this module each
 *   consumer hand-rolled its own walk over `chat`, so regex cooking,
 *   depth computation and system-floor handling drifted between entry
 *   points. This module is the single accessor: it walks `context.chat`
 *   once, computes real depths-from-end, cooks every floor's text
 *   through the plugin regex lane, and hands back plain records that
 *   later tasks convert into task messages / frame walks.
 *
 * Depth semantics:
 *   Reuses `computeDepthsFromEnd` from `chat-regex.js`: depth is
 *   0-based counting from the END of the usable chat, system floors
 *   skipped, so a plugin sees the same depth numbering the main
 *   generation pipeline feeds to `applyRegex` (`maxDepth` authored on
 *   a script means the same thing here).
 *
 * Roles:
 *   Default roles are ['user', 'assistant'], which also excludes
 *   `is_system` floors — matching the main pipeline's treatment of
 *   system messages (never regex-cooked as chat text). Passing an
 *   explicit roles list containing 'system' re-includes them; such
 *   records keep `depth: undefined` (system floors sit outside the
 *   depth numbering) and their text is cooked with no depth filter,
 *   mirroring how undepthed text is handled.
 *
 * Filters:
 *   `fromSeq`/`toSeq` (1-based chat positions) and
 *   `fromDepth`/`toDepth` (inclusive bounds on the computed depth)
 *   narrow WHICH records come back. Every returned record always
 *   carries ALL FloorRecord fields — filters never strip fields.
 *
 * Regex engine access:
 *   Same lazy-ctx pattern as `chat-regex.js` / `plugin-prompt-regex.js`:
 *   primitives are consumed via `Luker.getContext().regex` (three-layer
 *   API). Direct import from `../extensions/regex/engine.js` would
 *   transitively pull `public/script.js` and its DOM bootstrap chain —
 *   poison for the jest module graph. Ctx resolution is lazy +
 *   memoized for the same reasons as there.
 */

import { computeDepthsFromEnd } from './chat-regex.js';
import { markPluginFloorMessage } from './plugin-prompt-regex.js';

let __regexApiCache = undefined;

function getRegexApi() {
    if (__regexApiCache !== undefined) return __regexApiCache;
    try {
        const ctx = globalThis.Luker?.getContext?.();
        const api = ctx?.regex;
        if (api && typeof api.applyRegex === 'function' && api.placement
            && typeof api.placement.USER_INPUT === 'number'
            && typeof api.placement.AI_OUTPUT === 'number') {
            __regexApiCache = api;
        } else {
            __regexApiCache = null;
        }
    } catch {
        __regexApiCache = null;
    }
    return __regexApiCache;
}

/**
 * Test-only: reset the cached ctx.regex reference. Not part of the
 * runtime contract; production code path only ever memoizes once.
 */
export function __resetPluginFloorsCacheForTests() {
    __regexApiCache = undefined;
}

const DEFAULT_ROLES = ['user', 'assistant'];

function normalizeRoleList(roles) {
    if (!Array.isArray(roles)) return DEFAULT_ROLES;
    const normalized = roles
        .map(role => String(role ?? '').trim().toLowerCase())
        .filter(Boolean);
    return normalized.length > 0 ? normalized : DEFAULT_ROLES;
}

/**
 * Cook one chat message's text through the plugin regex lane with a
 * real chat depth. Single-text primitive shared by {@link readPluginFloors}
 * and by consumers doing their own internal frame walk (memory-graph)
 * who already know each frame's depth.
 *
 * Placement follows the message's authorship: `is_user` → USER_INPUT,
 * otherwise AI_OUTPUT. Returns raw `mes` when the regex API isn't
 * reachable so callers degrade gracefully rather than crashing.
 *
 * @param {object} message — chat-message-shaped object (`mes` + `is_user`)
 * @param {number|undefined} depth — 0-based depth from chat tail;
 *     `undefined` disables depth-based script filtering
 * @returns {string} the text ready to feed to an LLM
 */
export function cookPluginFloorText(message, depth) {
    const raw = String(message?.mes ?? '');
    if (!raw) return '';
    const api = getRegexApi();
    if (!api) return raw;
    const placement = message?.is_user ? api.placement.USER_INPUT : api.placement.AI_OUTPUT;
    // Plugin lane: pluginOnly scripts apply here with the floor's real
    // depth; promptOnly scripts stay scoped to the main pipeline.
    return api.applyRegex(raw, placement, { isPluginPrompt: true, depth });
}

/**
 * Convert a FloorRecord into a task message for plugin-built prompt
 * arrays. Role follows authorship flags checked in order: `is_user` →
 * 'user', then `is_system` → 'system', otherwise 'assistant'. Stamps
 * the internal-only provenance marker via
 * `markPluginFloorMessage`, which tells the dispatch layer
 * ({@link applyPluginLaneRegex}) this text was ALREADY cooked here and
 * must not be regexed a second time. The marker never reaches network
 * payloads — the dispatcher strips it before sending.
 *
 * @param {object} record — FloorRecord from {@link readPluginFloors}
 * @returns {{role: string, content: string, sourceFloorIndex: number}}
 */
export function floorRecordToTaskMessage(record) {
    return markPluginFloorMessage(
        {
            role: record?.is_user ? 'user' : (record?.is_system ? 'system' : 'assistant'),
            content: String(record?.mesCooked ?? ''),
        },
        record?.sourceIndex,
    );
}

function roleForMessage(message) {
    if (message.is_system) return 'system';
    return message.is_user ? 'user' : 'assistant';
}

/**
 * Read the current chat's floors as cooked records for plugin LLM
 * requests. Walks `context.chat` exactly once.
 *
 * @param {object} context — a Luker context object (must expose `chat`)
 * @param {object} [options]
 * @param {number} [options.fromSeq] — inclusive 1-based lower seq bound
 * @param {number} [options.toSeq] — inclusive 1-based upper seq bound
 * @param {number} [options.fromDepth] — inclusive lower depth bound
 * @param {number} [options.toDepth] — inclusive upper depth bound
 * @param {string[]} [options.roles] — role whitelist; default
 *     ['user','assistant'] (which excludes is_system floors)
 * @returns {Array<{seq: number, sourceIndex: number, depth: number|undefined,
 *     is_user: boolean, is_system: boolean, mesRaw: string, mesCooked: string}>}
 */
export function readPluginFloors(context, options = {}) {
    const chat = context?.chat;
    if (!Array.isArray(chat)) return [];

    const depths = computeDepthsFromEnd(chat);
    const roles = normalizeRoleList(options.roles);
    const fromSeq = Number.isFinite(Number(options.fromSeq)) ? Number(options.fromSeq) : null;
    const toSeq = Number.isFinite(Number(options.toSeq)) ? Number(options.toSeq) : null;
    const fromDepth = Number.isFinite(Number(options.fromDepth)) ? Number(options.fromDepth) : null;
    const toDepth = Number.isFinite(Number(options.toDepth)) ? Number(options.toDepth) : null;

    const records = [];
    for (let index = 0; index < chat.length; index += 1) {
        const message = chat[index];
        if (!message || typeof message !== 'object') continue;

        const role = roleForMessage(message);
        if (!roles.includes(role)) continue;

        const depth = depths[index];
        const seq = index + 1;
        if (fromSeq !== null && seq < fromSeq) continue;
        if (toSeq !== null && seq > toSeq) continue;
        if (fromDepth !== null && !(Number.isFinite(depth) && depth >= fromDepth)) continue;
        if (toDepth !== null && !(Number.isFinite(depth) && depth <= toDepth)) continue;

        records.push({
            seq,
            sourceIndex: index,
            depth,
            is_user: !!message.is_user,
            is_system: !!message.is_system,
            mesRaw: String(message.mes ?? ''),
            mesCooked: cookPluginFloorText(message, depth),
        });
    }
    return records;
}
