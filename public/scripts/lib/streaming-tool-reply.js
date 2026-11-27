// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared zero-DOM configuration, path parsing, and schema inspection helpers
 * for streaming a string argument of a tool call into the chat preview.
 * Imported by both browser streaming consumers and backend dispatchers.
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_ARRAY_INDEX = 0xffffffff; // cap-ok: ECMAScript Array index upper bound (2^32 - 1)

function decodeQuotedPathKey(quoted) {
    const json = quoted.startsWith('\'')
        ? '"' + quoted.slice(1, -1).replace(/\\.|"/g, ch => (ch === '\\\'' ? '\'' : ch === '"' ? '\\"' : ch)) + '"'
        : quoted;
    try {
        const key = JSON.parse(json);
        return typeof key === 'string' && !FORBIDDEN_KEYS.has(key) ? key : null;
    } catch {
        return null;
    }
}

/**
 * Parse a tool argument path into canonical object-key / array-index segments.
 * Accepts:
 *   - bare top-level key: `'body'` -> `['body']`
 *   - dot/bracket path: `'payload.items[0].text'` -> `['payload', 'items', 0, 'text']`
 *   - JSONPath: `'$.items[0]["a.b"]'` -> `['items', 0, 'a.b']`
 *   - pre-split segment array: `['payload', 0, 'text']`
 *
 * Returns `null` when invalid or empty.
 *
 * @param {unknown} pathOrSegments
 * @param {{ requireRootDollar?: boolean }} [options]
 * @returns {Array<string|number>|null}
 */
export function parseArgumentPath(pathOrSegments, { requireRootDollar = false } = {}) {
    if (Array.isArray(pathOrSegments)) {
        if (requireRootDollar || pathOrSegments.length === 0) return null;
        const segments = [];
        for (let i = 0; i < pathOrSegments.length; i += 1) {
            const seg = pathOrSegments[i];
            if (typeof seg === 'string') {
                if (!seg || FORBIDDEN_KEYS.has(seg)) return null;
                segments.push(seg);
            } else if (typeof seg === 'number' && Number.isSafeInteger(seg) && seg >= 0 && seg < MAX_ARRAY_INDEX) {
                if (i === 0) return null;
                segments.push(seg);
            } else {
                return null;
            }
        }
        return segments;
    }

    if (typeof pathOrSegments !== 'string') return null;
    const raw = pathOrSegments.trim();
    if (!raw) return null;

    if (requireRootDollar && !raw.startsWith('$')) return null;

    let normalized;
    if (raw.startsWith('$')) {
        normalized = raw;
    } else if (raw.startsWith('[')) {
        normalized = `$${raw}`;
    } else {
        normalized = `$.${raw}`;
    }

    const token = /\.([^.[\]\s]+)|\[(\d+)\]|\[("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\]/gy;
    const segments = [];
    for (let offset = 1; offset < normalized.length;) {
        token.lastIndex = offset;
        const match = token.exec(normalized);
        if (!match) return null;
        if (match[2] !== undefined) {
            const index = Number(match[2]);
            if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_ARRAY_INDEX) return null;
            segments.push(index);
        } else if (match[3] !== undefined) {
            const key = decodeQuotedPathKey(match[3]);
            if (key === null) return null;
            segments.push(key);
        } else {
            const key = match[1];
            if (!key || FORBIDDEN_KEYS.has(key)) return null;
            segments.push(key);
        }
        offset = token.lastIndex;
    }

    if (!segments.length || typeof segments[0] !== 'string') return null;
    return segments;
}

/**
 * Format a normalized segment path back into a stable canonical cache key.
 * @param {Array<string|number>} segments
 * @returns {string}
 */
export function formatArgumentPathKey(segments) {
    return JSON.stringify(segments);
}

/**
 * Normalize a streaming tool-reply preview declaration from preset extensions,
 * `generate_data`, or tool registration into `{ name, argument, path }`.
 * Returns `null` when missing or invalid.
 *
 * @param {unknown} raw
 * @returns {{ name: string, argument: string, path: Array<string|number> } | null}
 */
export function normalizeStreamingToolReplyConfig(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) return null;

    const rawArg = raw.argument;
    const path = parseArgumentPath(rawArg);
    if (!path) return null;

    const argument = typeof rawArg === 'string'
        ? rawArg.trim()
        : path.map((seg, i) => (typeof seg === 'number' ? `[${seg}]` : (i === 0 ? seg : `.${seg}`))).join('');
    return { name, argument, path };
}

/**
 * Read a value from a decoded tool-arguments object using either an exact
 * top-level property match or parsed nested path segments.
 *
 * @param {unknown} root
 * @param {unknown} argumentOrPath
 * @returns {unknown}
 */
export function getValueAtArgumentPath(root, argumentOrPath) {
    if (!root || typeof root !== 'object') return undefined;
    if (typeof argumentOrPath === 'string' && Object.hasOwn(root, argumentOrPath)) {
        return root[argumentOrPath];
    }
    const segments = parseArgumentPath(argumentOrPath);
    if (!segments) return undefined;
    let node = root;
    for (const seg of segments) {
        if (node === null || node === undefined || typeof node !== 'object') return undefined;
        if (typeof seg === 'number') {
            if (!Array.isArray(node) || seg >= node.length) return undefined;
            node = node[seg];
        } else {
            if (Array.isArray(node) || !Object.hasOwn(node, seg)) return undefined;
            node = node[seg];
        }
    }
    return node;
}

function unwrapCompositeSchema(schemaNode) {
    if (!schemaNode || typeof schemaNode !== 'object') return null;
    if (schemaNode.properties || schemaNode.items || schemaNode.type) {
        return schemaNode;
    }
    const branches = Array.isArray(schemaNode.anyOf)
        ? schemaNode.anyOf
        : (Array.isArray(schemaNode.oneOf) ? schemaNode.oneOf : null);
    if (!branches) return schemaNode;
    const nonNull = branches.find(branch => branch && typeof branch === 'object' && String(branch.type || '').toLowerCase() !== 'null');
    return nonNull || schemaNode;
}

/**
 * Resolve the JSON Schema node for a target argument path inside a tool's
 * `parameters` (or `input_schema`) declaration.
 *
 * @param {unknown} parametersSchema
 * @param {unknown} argumentOrPath
 * @returns {object|null}
 */
export function resolveSchemaPropertyAtPath(parametersSchema, argumentOrPath) {
    if (!parametersSchema || typeof parametersSchema !== 'object') return null;
    if (typeof argumentOrPath === 'string'
        && parametersSchema.properties
        && typeof parametersSchema.properties === 'object'
        && Object.hasOwn(parametersSchema.properties, argumentOrPath)) {
        return parametersSchema.properties[argumentOrPath] ?? null;
    }
    const segments = parseArgumentPath(argumentOrPath);
    if (!segments) return null;

    let current = unwrapCompositeSchema(parametersSchema);
    for (const seg of segments) {
        if (!current || typeof current !== 'object') return null;
        if (typeof seg === 'number') {
            if (!current.items || typeof current.items !== 'object') return null;
            current = unwrapCompositeSchema(Array.isArray(current.items) ? current.items[seg] : current.items);
        } else {
            const props = current.properties;
            if (!props || typeof props !== 'object' || !Object.hasOwn(props, seg)) return null;
            current = unwrapCompositeSchema(props[seg]);
        }
    }
    return current;
}

/**
 * Determine whether a JSON Schema node permits string values.
 * Handles lowercase/uppercase type names (e.g. OpenAI `'string'`, Gemini `'STRING'`),
 * union type arrays (`['string', 'null']`), and `anyOf` / `oneOf` unions.
 *
 * @param {unknown} schemaNode
 * @returns {boolean}
 */
export function isStringSchemaNode(schemaNode) {
    if (!schemaNode || typeof schemaNode !== 'object') return false;
    if (typeof schemaNode.type === 'string') {
        return schemaNode.type.toLowerCase() === 'string';
    }
    if (Array.isArray(schemaNode.type)) {
        return schemaNode.type.some(t => typeof t === 'string' && t.toLowerCase() === 'string');
    }
    const branches = Array.isArray(schemaNode.anyOf)
        ? schemaNode.anyOf
        : (Array.isArray(schemaNode.oneOf) ? schemaNode.oneOf : null);
    if (branches) {
        return branches.some(isStringSchemaNode);
    }
    return false;
}

/**
 * Resolve the active streaming tool-reply preview configuration for a chat
 * completion request. Precedence:
 *   1. Explicit `requestBody.luker_streaming_tool_reply` (set by a hook; `false`/`null` opts out)
 *   2. Preset `requestSettings.extensions.luker.streaming_tool_reply`
 *   3. Registered `ToolManager` tool declaring `streamingPreviewArgument` among active `requestBody.tools`
 *
 * @param {object} params
 * @param {object} [params.requestBody]
 * @param {object} [params.requestSettings]
 * @param {Array<{ name: string, streamingPreviewArgument: unknown }>} [params.registeredTools]
 * @param {boolean} [params.shouldRunChatCompletionHooks]
 * @param {boolean} [params.stream]
 * @returns {{ name: string, argument: string, path: Array<string|number> } | null}
 */
export function resolveStreamingToolReplyTarget({
    requestBody = {},
    requestSettings = {},
    registeredTools = [],
    shouldRunChatCompletionHooks = true,
    stream = false,
} = {}) {
    if (!stream) return null;

    if (requestBody && typeof requestBody === 'object' && Object.hasOwn(requestBody, 'luker_streaming_tool_reply')) {
        const explicit = requestBody.luker_streaming_tool_reply;
        if (explicit === false || explicit === null) return null;
        return normalizeStreamingToolReplyConfig(explicit);
    }

    if (!shouldRunChatCompletionHooks) return null;

    const fromPreset = normalizeStreamingToolReplyConfig(requestSettings?.extensions?.luker?.streaming_tool_reply);
    if (fromPreset) return fromPreset;

    const activeTools = Array.isArray(requestBody?.tools) ? requestBody.tools : [];
    if (activeTools.length === 0 || !Array.isArray(registeredTools) || registeredTools.length === 0) {
        return null;
    }

    const activeNames = new Set(
        activeTools
            .map(tool => String(tool?.function?.name || tool?.name || '').trim())
            .filter(Boolean),
    );
    if (activeNames.size === 0) return null;

    const forcedName = typeof requestBody?.tool_choice === 'object' && requestBody.tool_choice !== null
        ? String(requestBody.tool_choice?.function?.name || requestBody.tool_choice?.name || '').trim()
        : '';

    let firstMatch = null;
    for (const reg of registeredTools) {
        if (!reg || typeof reg !== 'object') continue;
        const name = String(reg.name || '').trim();
        if (!name || !activeNames.has(name)) continue;
        const normalized = normalizeStreamingToolReplyConfig({
            name,
            argument: reg.streamingPreviewArgument,
        });
        if (!normalized) continue;
        if (forcedName && normalized.name === forcedName) {
            return normalized;
        }
        if (!firstMatch) {
            firstMatch = normalized;
        }
    }
    return firstMatch;
}

/**
 * Compute per-frame display text vs committed model output during streaming so
 * a live tool-argument preview never pollutes `StreamingProcessor.result`.
 *
 * @param {object} params
 * @param {string} [params.output]
 * @param {string} [params.toolCallPreview]
 * @param {string} [params.previousResult]
 * @param {boolean} [params.previousShowingPreview]
 */
export function resolveStreamingFrameDisplay({
    output = '',
    toolCallPreview = '',
    previousResult = '',
    previousShowingPreview = false,
} = {}) {
    const safeOutput = typeof output === 'string' ? output : '';
    const safePreview = typeof toolCallPreview === 'string' ? toolCallPreview : '';
    const hasRealOutput = safeOutput.trim().length > 0;
    const hasPreview = safePreview.length > 0;
    const showingToolCallPreview = !hasRealOutput && hasPreview;
    const displayText = showingToolCallPreview ? safePreview : safeOutput;
    const firstToolPreview = showingToolCallPreview && !previousShowingPreview && !String(previousResult || '').trim();
    const previewCleared = Boolean(previousShowingPreview && !showingToolCallPreview);

    return {
        displayText,
        committedResult: safeOutput,
        toolCallPreview: safePreview,
        showingToolCallPreview,
        firstToolPreview,
        previewCleared,
    };
}

/**
 * Decide the final text returned by `StreamingProcessor.generate()`:
 *   - Real assistant output (or a consuming formatter's EOF text) always wins.
 *   - When completed tool calls are present with no real text, return `''` so
 *     `ToolManager` executes without treating the preview as assistant prose.
 *   - When interrupted or length-truncated with no completed tool calls,
 *     preserve the readable partial preview.
 *
 * @param {object} params
 * @param {string} [params.result]
 * @param {string} [params.toolCallPreview]
 * @param {boolean} [params.showingToolCallPreview]
 * @param {boolean} [params.hasCompletedToolCalls]
 * @returns {string}
 */
export function resolveStreamingFinalReturn({
    result = '',
    toolCallPreview = '',
    showingToolCallPreview = false,
    hasCompletedToolCalls = false,
} = {}) {
    const safeResult = typeof result === 'string' ? result : '';
    if (safeResult.trim().length > 0) {
        return safeResult;
    }
    if (hasCompletedToolCalls) {
        return safeResult;
    }
    if (showingToolCallPreview && typeof toolCallPreview === 'string' && toolCallPreview.length > 0) {
        return toolCallPreview;
    }
    return safeResult;
}

/**
 * True when the streaming bubble only displayed a transient tool-argument
 * preview with no committed assistant prose, so completed tool-call handoff
 * must not finalize the raw preview as an assistant turn before tool execution.
 *
 * @param {{ showingToolCallPreview?: boolean, result?: string }} params
 * @returns {boolean}
 */
export function shouldSkipIntermediaryFinalizeForToolPreview({
    showingToolCallPreview = false,
    result = '',
} = {}) {
    return Boolean(showingToolCallPreview && !String(result || '').trim());
}
