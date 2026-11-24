/**
 * Pure helpers for the Request Inspector's Tools section.
 *
 * Kept free of DOM and app imports so it can be unit-tested under the node
 * test environment; the rendering layer in `request-inspector.js` composes
 * these into markup.
 */

function isSchema(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readDescription(obj) {
    return typeof obj?.description === 'string' ? obj.description : '';
}

// A tool definition that carries a name plus a JSON Schema under either
// `parameters` (OpenAI / Gemini) or `input_schema` (Claude).
function fromFunctionObject(fn) {
    if (!isSchema(fn)) return null;
    const name = typeof fn.name === 'string' ? fn.name : '';
    if (!name) return null;
    const parameters = isSchema(fn.parameters) ? fn.parameters
        : (isSchema(fn.input_schema) ? fn.input_schema : null);
    return { name, description: readDescription(fn), parameters };
}

// Expand one entry of a wire request's `tools` array. Each provider wraps the
// same information differently:
//   OpenAI        { type: 'function', function: { name, description, parameters } }
//   OpenAI Resp.  { type: 'function', name, description, parameters }
//   Claude        { name, description, input_schema }
//   Gemini        { functionDeclarations: [{ name, description, parameters }] }
//   Gemini custom { googleSearch: {} } / { codeExecution: {} }
//   Built-in      { type: 'web_search_preview' }
function collectToolEntry(entry, out) {
    if (!isSchema(entry)) return;

    if (Array.isArray(entry.functionDeclarations)) {
        for (const decl of entry.functionDeclarations) {
            const tool = fromFunctionObject(decl);
            if (tool) out.push(tool);
        }
        return;
    }

    if (isSchema(entry.function)) {
        const tool = fromFunctionObject(entry.function);
        if (tool) out.push(tool);
        return;
    }

    if (typeof entry.name === 'string' && entry.name) {
        out.push({
            name: entry.name,
            description: readDescription(entry),
            parameters: isSchema(entry.input_schema) ? entry.input_schema
                : (isSchema(entry.parameters) ? entry.parameters : null),
        });
        return;
    }

    if (typeof entry.type === 'string' && entry.type && entry.type !== 'function') {
        out.push({ name: entry.type, description: '', parameters: null });
        return;
    }

    // Gemini custom tools are a single-key object whose key is the tool name.
    const keys = Object.keys(entry);
    if (keys.length === 1) {
        out.push({ name: keys[0], description: '', parameters: null });
    }
}

/**
 * Normalize a provider-native wire request body into a flat tool list plus the
 * raw `tool_choice` value. Handles OpenAI, OpenAI Responses, Claude, Gemini,
 * and the legacy top-level `functions` array.
 *
 * @param {object|null} wireRequest
 * @returns {{ tools: Array<{name: string, description: string, parameters: object|null}>, toolChoice: any }}
 */
export function normalizeWireTools(wireRequest) {
    const tools = [];
    let toolChoice = null;

    if (isSchema(wireRequest)) {
        if (Array.isArray(wireRequest.tools)) {
            for (const entry of wireRequest.tools) collectToolEntry(entry, tools);
        }
        if (Array.isArray(wireRequest.functions)) {
            for (const fn of wireRequest.functions) {
                const tool = fromFunctionObject(fn);
                if (tool) tools.push(tool);
            }
        }
        if (wireRequest.tool_choice !== undefined) toolChoice = wireRequest.tool_choice;
        else if (wireRequest.toolChoice !== undefined) toolChoice = wireRequest.toolChoice;
    }

    return { tools, toolChoice };
}

/**
 * Render a raw `tool_choice` value as a short human-readable label.
 * @param {any} toolChoice
 * @returns {string|null}
 */
export function describeToolChoice(toolChoice) {
    if (toolChoice == null) return null;
    if (typeof toolChoice === 'string') return toolChoice;
    if (isSchema(toolChoice)) {
        const type = typeof toolChoice.type === 'string' ? toolChoice.type : '';
        const name = (isSchema(toolChoice.function) && typeof toolChoice.function.name === 'string' && toolChoice.function.name)
            || (typeof toolChoice.name === 'string' ? toolChoice.name : '');
        if (type === 'function' && name) return `function: ${name}`;
        if (type === 'tool' && name) return `tool: ${name}`;
        if (type) return type;
        try { return JSON.stringify(toolChoice); } catch { return String(toolChoice); }
    }
    return String(toolChoice);
}

function describeSchemaType(prop) {
    const raw = prop.type;
    if (typeof raw === 'string' && raw) return raw.toLowerCase();
    if (Array.isArray(raw) && raw.length) return raw.map(t => String(t).toLowerCase()).join(' | ');
    if (isSchema(prop.properties)) return 'object';
    if (prop.items) return 'array';
    if (prop.anyOf || prop.oneOf || prop.allOf) return 'any';
    return '';
}

function walkSchema(schema, depth, rows) {
    if (!isSchema(schema) || !isSchema(schema.properties)) return;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const [name, prop] of Object.entries(schema.properties)) {
        if (!isSchema(prop)) continue;
        rows.push({
            name,
            type: describeSchemaType(prop),
            required: required.includes(name),
            description: readDescription(prop),
            depth,
        });
        if (isSchema(prop.properties)) walkSchema(prop, depth + 1, rows);
        if (isSchema(prop.items) && isSchema(prop.items.properties)) walkSchema(prop.items, depth + 1, rows);
    }
}

/**
 * Flatten a tool's JSON Schema into renderable parameter rows. Nested object
 * properties and array-of-object items are emitted as deeper rows.
 *
 * @param {object|null} parameters
 * @returns {Array<{name: string, type: string, required: boolean, description: string, depth: number}>}
 */
export function buildToolParamRows(parameters) {
    const rows = [];
    walkSchema(parameters, 0, rows);
    return rows;
}

/**
 * Count a tool's top-level parameters.
 * @param {object|null} parameters
 * @returns {number}
 */
export function countToolParams(parameters) {
    if (!isSchema(parameters) || !isSchema(parameters.properties)) return 0;
    return Object.keys(parameters.properties).length;
}

/**
 * Validate and normalize a request-inspector entry ID before interpolating it
 * into `/api/request-inspector/:id`. Rejects empty strings, `.`/`..`, reserved
 * `list` (case-insensitive), slashes, query/hash delimiters, whitespace, and
 * ASCII control characters.
 *
 * @param {any} id
 * @returns {string|null}
 */
export function normalizeRequestId(id) {
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    const trimmed = String(id).trim();
    if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.toLowerCase() === 'list') return null;
    if (trimmed.includes('..') || /[/\\?#\s\u0000-\u001f\u007f]/.test(trimmed)) return null;
    return trimmed;
}
