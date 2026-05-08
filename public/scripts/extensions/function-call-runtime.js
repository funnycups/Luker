// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
// Implementation source: Toolify: Empower any LLM with function calling capabilities. (https://github.com/funnycups/Toolify)

const RANDOM_SIGNAL_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const DEFAULT_REASONING_TAGS = Object.freeze(['thought', 'think']);
const FUNCTION_CALLS_TAG = 'function_calls';
const FUNCTION_CALL_TAG = 'function_call';
const TOOL_TAG = 'tool';
const ARGS_JSON_TAG = 'args_json';

function normalizeReasoningTagNames(tagNameOrList) {
    if (Array.isArray(tagNameOrList)) {
        const names = tagNameOrList
            .map(item => String(item || '').trim().toLowerCase())
            .filter(Boolean);
        return names.length > 0 ? [...new Set(names)] : [...DEFAULT_REASONING_TAGS];
    }
    const single = String(tagNameOrList || '').trim().toLowerCase();
    if (!single) {
        return [...DEFAULT_REASONING_TAGS];
    }
    return [...new Set([single])];
}

function stripSingleTagBlocks(source, tagName) {
    const openTag = `<${tagName}>`;
    const closeTag = `</${tagName}>`;
    if (!source || !source.includes(openTag)) {
        return source;
    }

    let output = '';
    let index = 0;
    let depth = 0;

    while (index < source.length) {
        if (source.startsWith(openTag, index)) {
            depth += 1;
            index += openTag.length;
            continue;
        }
        if (source.startsWith(closeTag, index)) {
            if (depth > 0) {
                depth -= 1;
            } else {
                output += closeTag;
            }
            index += closeTag.length;
            continue;
        }
        if (depth === 0) {
            output += source[index];
        }
        index += 1;
    }

    return output;
}

export const TOOL_PROTOCOL_STYLE = Object.freeze({
    TABLE: 'table',
    JSON_SCHEMA: 'json_schema',
});

function normalizeAllowedNameSet(allowedNames = null) {
    if (allowedNames instanceof Set) {
        return allowedNames;
    }
    if (Array.isArray(allowedNames)) {
        return new Set(allowedNames.map(name => String(name || '').trim()).filter(Boolean));
    }
    return null;
}

function normalizeTools(tools = []) {
    return Array.isArray(tools) ? tools : [];
}

function normalizeToolName(name) {
    return String(name || '').trim();
}

function normalizeSchemaFromTool(tool) {
    const schema = tool?.function?.parameters;
    return schema && typeof schema === 'object' ? schema : { type: 'object', additionalProperties: true };
}

function stringifyPromptValue(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function formatSchemaTypeLabel(typeValue) {
    if (Array.isArray(typeValue)) {
        return typeValue.map(item => String(item || '').trim()).filter(Boolean).join(' | ') || 'any';
    }
    const normalized = String(typeValue || '').trim();
    return normalized || 'any';
}

function buildHumanReadableParameterDetails(schema) {
    const safeSchema = schema && typeof schema === 'object' ? schema : {};
    const properties = safeSchema.properties && typeof safeSchema.properties === 'object'
        ? safeSchema.properties
        : {};
    const requiredSet = new Set(
        Array.isArray(safeSchema.required)
            ? safeSchema.required.map(item => String(item || '').trim()).filter(Boolean)
            : [],
    );

    const lines = [];
    if (Object.hasOwn(safeSchema, 'additionalProperties')) {
        lines.push(`Schema rules: additionalProperties=${stringifyPromptValue(safeSchema.additionalProperties)}`);
    }

    const appendPropertyDetails = (currentProperties, currentRequiredSet, pathPrefix = '') => {
        for (const [fieldName, fieldSchemaRaw] of Object.entries(currentProperties || {})) {
            const fieldSchema = fieldSchemaRaw && typeof fieldSchemaRaw === 'object' ? fieldSchemaRaw : {};
            const fullPath = pathPrefix ? `${pathPrefix}.${fieldName}` : fieldName;
            const constraints = {};
            for (const key of [
                'minimum',
                'maximum',
                'exclusiveMinimum',
                'exclusiveMaximum',
                'minLength',
                'maxLength',
                'pattern',
                'format',
                'minItems',
                'maxItems',
                'uniqueItems',
            ]) {
                if (Object.hasOwn(fieldSchema, key)) {
                    constraints[key] = fieldSchema[key];
                }
            }
            const itemSchema = fieldSchema.items && typeof fieldSchema.items === 'object'
                ? fieldSchema.items
                : null;
            if (fieldSchema.type === 'array' && itemSchema?.type) {
                constraints['items.type'] = itemSchema.type;
            }

            lines.push(`- ${fullPath}:`);
            lines.push(`  - type: ${formatSchemaTypeLabel(fieldSchema.type)}`);
            lines.push(`  - required: ${currentRequiredSet.has(fieldName) ? 'Yes' : 'No'}`);
            if (fieldSchema.description) {
                lines.push(`  - description: ${String(fieldSchema.description)}`);
            }
            if (Object.hasOwn(fieldSchema, 'enum')) {
                lines.push(`  - enum: ${stringifyPromptValue(fieldSchema.enum)}`);
            }
            if (Object.hasOwn(fieldSchema, 'default')) {
                lines.push(`  - default: ${stringifyPromptValue(fieldSchema.default)}`);
            }
            if (Object.hasOwn(fieldSchema, 'examples')) {
                lines.push(`  - examples: ${stringifyPromptValue(fieldSchema.examples)}`);
            } else if (Object.hasOwn(fieldSchema, 'example')) {
                lines.push(`  - example: ${stringifyPromptValue(fieldSchema.example)}`);
            }
            if (Object.keys(constraints).length > 0) {
                lines.push(`  - constraints: ${stringifyPromptValue(constraints)}`);
            }

            const nestedProperties = fieldSchema.properties && typeof fieldSchema.properties === 'object'
                ? fieldSchema.properties
                : null;
            if (nestedProperties) {
                const nestedRequiredSet = new Set(
                    Array.isArray(fieldSchema.required)
                        ? fieldSchema.required.map(item => String(item || '').trim()).filter(Boolean)
                        : [],
                );
                appendPropertyDetails(nestedProperties, nestedRequiredSet, fullPath);
            }

            const itemProperties = itemSchema?.properties && typeof itemSchema.properties === 'object'
                ? itemSchema.properties
                : null;
            if (fieldSchema.type === 'array' && itemProperties) {
                const nestedRequiredSet = new Set(
                    Array.isArray(itemSchema.required)
                        ? itemSchema.required.map(item => String(item || '').trim()).filter(Boolean)
                        : [],
                );
                appendPropertyDetails(itemProperties, nestedRequiredSet, `${fullPath}[]`);
            }
        }
    };

    appendPropertyDetails(properties, requiredSet);

    return lines.join('\n') || '(no parameter details)';
}

function escapeXmlText(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&apos;');
}

function decodeXmlText(value) {
    return String(value ?? '')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', '\'')
        .replaceAll('&amp;', '&');
}

function wrapCdata(value) {
    const safe = String(value ?? '').replaceAll(']]>', ']]]]><![CDATA[>');
    return `<![CDATA[${safe}]]>`;
}

function unwrapCdata(value) {
    const source = String(value ?? '');
    if (!source.includes('<![CDATA[')) {
        return source;
    }

    let output = '';
    let index = 0;

    while (index < source.length) {
        const cdataStart = source.indexOf('<![CDATA[', index);
        if (cdataStart === -1) {
            output += source.slice(index);
            break;
        }

        output += source.slice(index, cdataStart);
        const cdataEnd = source.indexOf(']]>', cdataStart + 9);
        if (cdataEnd === -1) {
            output += source.slice(cdataStart + 9);
            break;
        }

        output += source.slice(cdataStart + 9, cdataEnd);
        index = cdataEnd + 3;
    }

    return output;
}

function extractXmlTagBlock(source, tagName, startIndex = 0) {
    const safeSource = String(source ?? '');
    const safeTag = String(tagName || '').trim();
    if (!safeSource || !safeTag) {
        return null;
    }

    const openTag = `<${safeTag}>`;
    const closeTag = `</${safeTag}>`;
    const start = safeSource.indexOf(openTag, Math.max(0, startIndex));
    if (start === -1) {
        return null;
    }

    const innerStart = start + openTag.length;
    let index = innerStart;

    while (index < safeSource.length) {
        if (safeSource.startsWith('<![CDATA[', index)) {
            const cdataEnd = safeSource.indexOf(']]>', index + 9);
            if (cdataEnd === -1) {
                return null;
            }
            index = cdataEnd + 3;
            continue;
        }

        if (safeSource.startsWith(closeTag, index)) {
            const end = index + closeTag.length;
            return {
                full: safeSource.slice(start, end),
                inner: safeSource.slice(innerStart, index),
                start,
                end,
            };
        }

        index += 1;
    }

    return null;
}

function extractAllXmlTagBlocks(source, tagName) {
    const safeSource = String(source ?? '');
    const blocks = [];
    let cursor = 0;

    while (cursor < safeSource.length) {
        const block = extractXmlTagBlock(safeSource, tagName, cursor);
        if (!block) {
            break;
        }
        blocks.push(block);
        cursor = Math.max(block.end, cursor + 1);
    }

    return blocks;
}

function isLikelySsePayload(text) {
    const source = String(text || '');
    return source.includes('\ndata:') || source.startsWith('data:');
}

function extractSseTextContent(raw) {
    const source = String(raw || '');
    if (!source.trim() || !isLikelySsePayload(source)) {
        return source.trim();
    }
    const lines = source.split(/\r?\n/);
    let out = '';
    for (const line of lines) {
        if (!line.startsWith('data:')) {
            continue;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') {
            continue;
        }
        try {
            const parsed = JSON.parse(payload);
            const text =
                parsed?.choices?.[0]?.delta?.content
                ?? parsed?.choices?.[0]?.message?.content
                ?? parsed?.choices?.[0]?.text
                ?? parsed?.delta?.text
                ?? parsed?.delta?.content
                ?? parsed?.candidates?.[0]?.content?.parts?.map(x => x?.text || '').join('')
                ?? '';
            out += String(text || '');
        } catch {
            continue;
        }
    }
    return out.trim();
}

function extractTextFromContentNode(node) {
    if (typeof node === 'string') {
        return node;
    }
    if (Array.isArray(node)) {
        return node.map(item => extractTextFromContentNode(item)).filter(Boolean).join('');
    }
    if (!node || typeof node !== 'object') {
        return '';
    }
    if (typeof node.text === 'string') {
        return node.text;
    }
    if (typeof node.content === 'string' || Array.isArray(node.content) || (node.content && typeof node.content === 'object')) {
        const contentText = extractTextFromContentNode(node.content);
        if (contentText) {
            return contentText;
        }
    }
    if (Array.isArray(node.parts)) {
        const partsText = node.parts.map(part => extractTextFromContentNode(part)).filter(Boolean).join('');
        if (partsText) {
            return partsText;
        }
    }
    if (Array.isArray(node.thinking)) {
        const thinkingText = node.thinking.map(part => extractTextFromContentNode(part)).filter(Boolean).join('');
        if (thinkingText) {
            return thinkingText;
        }
    }
    if (node.delta && typeof node.delta === 'object') {
        const deltaText = extractTextFromContentNode(node.delta);
        if (deltaText) {
            return deltaText;
        }
    }
    return '';
}

export function generateRandomTriggerSignal() {
    let suffix = '';
    for (let i = 0; i < 4; i += 1) {
        suffix += RANDOM_SIGNAL_CHARS[Math.floor(Math.random() * RANDOM_SIGNAL_CHARS.length)];
    }
    return `<Function_${suffix}_Start/>`;
}

export function stripThoughtBlocks(text, tagName = DEFAULT_REASONING_TAGS) {
    const source = String(text || '');
    const reasoningTags = normalizeReasoningTagNames(tagName);
    let output = source;
    for (const currentTagName of reasoningTags) {
        output = stripSingleTagBlocks(output, currentTagName);
    }
    return output;
}

export function findLastTriggerSignalOutsideThought(text, triggerSignal) {
    const source = String(text || '');
    const signal = String(triggerSignal || '').trim();
    if (!source || !signal) {
        return -1;
    }

    let index = 0;
    let depth = 0;
    let lastPos = -1;
    const openTags = DEFAULT_REASONING_TAGS.map(tag => `<${tag}>`);
    const closeTags = DEFAULT_REASONING_TAGS.map(tag => `</${tag}>`);

    while (index < source.length) {
        let matched = false;
        for (const openTag of openTags) {
            if (source.startsWith(openTag, index)) {
                depth += 1;
                index += openTag.length;
                matched = true;
                break;
            }
        }
        if (matched) {
            continue;
        }
        for (const closeTag of closeTags) {
            if (source.startsWith(closeTag, index)) {
                depth = Math.max(0, depth - 1);
                index += closeTag.length;
                matched = true;
                break;
            }
        }
        if (matched) {
            continue;
        }
        if (depth === 0 && source.startsWith(signal, index)) {
            lastPos = index;
            index += signal.length;
            continue;
        }
        index += 1;
    }
    return lastPos;
}

function buildReasoningTagLiterals(tagNames = DEFAULT_REASONING_TAGS) {
    return normalizeReasoningTagNames(tagNames).flatMap(tagName => ([
        { literal: `<${tagName}>`, delta: 1 },
        { literal: `</${tagName}>`, delta: -1 },
    ]));
}

export class PlainTextFunctionCallStreamDetector {
    #triggerSignal;
    #reasoningTagLiterals;
    #pending = '';
    #hidden = '';
    #raw = '';
    #reasoningDepth = 0;
    #detected = false;

    constructor({ triggerSignal = '', reasoningTagNames = DEFAULT_REASONING_TAGS } = {}) {
        this.#triggerSignal = String(triggerSignal || '').trim();
        this.#reasoningTagLiterals = buildReasoningTagLiterals(reasoningTagNames);
    }

    get hasDetectedToolCall() {
        return this.#detected;
    }

    get rawText() {
        return this.#raw;
    }

    processTextDelta(text) {
        const delta = String(text || '');
        if (!delta) {
            return { displayDelta: '', detected: this.#detected };
        }

        this.#raw += delta;
        if (this.#detected) {
            this.#hidden += delta;
            return { displayDelta: '', detected: true };
        }

        this.#pending += delta;
        let displayDelta = '';
        let index = 0;

        while (index < this.#pending.length) {
            const matchedTag = this.#matchReasoningTag(index);
            if (matchedTag) {
                displayDelta += matchedTag.literal;
                this.#reasoningDepth = Math.max(0, this.#reasoningDepth + matchedTag.delta);
                index += matchedTag.literal.length;
                continue;
            }

            if (!this.#isInsideReasoning() && this.#triggerSignal) {
                if (this.#pending.startsWith(this.#triggerSignal, index)) {
                    this.#detected = true;
                    this.#hidden = this.#pending.slice(index);
                    this.#pending = '';
                    return { displayDelta, detected: true };
                }

                if (this.#isCandidatePrefix(this.#pending.slice(index))) {
                    break;
                }
            } else if (this.#isCandidatePrefix(this.#pending.slice(index))) {
                break;
            }

            displayDelta += this.#pending[index];
            index += 1;
        }

        this.#pending = this.#pending.slice(index);
        return { displayDelta, detected: this.#detected };
    }

    finalize() {
        if (this.#detected) {
            if (this.#pending) {
                this.#hidden += this.#pending;
                this.#pending = '';
            }
            return {
                displayDelta: '',
                hiddenText: this.#hidden,
                rawText: this.#raw,
                detected: true,
            };
        }

        const displayDelta = this.#pending;
        this.#pending = '';
        return {
            displayDelta,
            hiddenText: '',
            rawText: this.#raw,
            detected: false,
        };
    }

    #isInsideReasoning() {
        return this.#reasoningDepth > 0;
    }

    #matchReasoningTag(index) {
        const source = this.#pending.slice(index);
        for (const tag of this.#reasoningTagLiterals) {
            if (source.startsWith(tag.literal)) {
                return tag;
            }
        }
        return null;
    }

    #isCandidatePrefix(source) {
        if (!source) {
            return false;
        }

        const candidates = [this.#triggerSignal]
            .concat(this.#reasoningTagLiterals.map(tag => tag.literal))
            .filter(Boolean);
        return candidates.some((candidate) =>
            source.length < candidate.length && candidate.startsWith(source),
        );
    }
}

export function getResponseMessageContent(responseData) {
    if (typeof responseData === 'string') {
        return extractSseTextContent(responseData);
    }
    if (responseData && typeof responseData === 'object') {
        const choice = responseData?.choices?.[0];
        const direct = choice?.message?.content;
        const directText = extractTextFromContentNode(direct);
        if (typeof directText === 'string' && directText.trim()) {
            return directText.trim();
        }
        const choiceText = extractTextFromContentNode(choice?.text);
        if (typeof choiceText === 'string' && choiceText.trim()) {
            return choiceText.trim();
        }
        const candidateText = extractTextFromContentNode(responseData?.candidates?.[0]?.content);
        if (typeof candidateText === 'string' && candidateText.trim()) {
            return candidateText.trim();
        }
        const altRaw = responseData?.content ?? responseData?.raw_text ?? responseData?.sse_text ?? '';
        const alt = typeof altRaw === 'string' ? altRaw : extractTextFromContentNode(altRaw);
        if (typeof alt === 'string' && alt.trim()) {
            return extractSseTextContent(alt);
        }
    }
    return '';
}

function parseArgsJsonPayload(payload, functionName) {
    const normalizedName = normalizeToolName(functionName);
    const rawPayload = decodeXmlText(unwrapCdata(payload)).trim();
    if (!rawPayload) {
        return {};
    }

    let parsed;
    try {
        parsed = JSON.parse(rawPayload);
    } catch {
        throw new Error(`Tool call '${normalizedName}' <args_json> is not valid JSON.`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Tool call '${normalizedName}' <args_json> must decode to a JSON object.`);
    }

    return parsed;
}

function parseFunctionCallsFromXmlText(source, allowSet = null) {
    const safeSource = String(source || '').trim();
    if (!safeSource) {
        return [];
    }

    const callsBlock = extractXmlTagBlock(safeSource, FUNCTION_CALLS_TAG);
    if (!callsBlock) {
        if (safeSource.includes(`<${FUNCTION_CALLS_TAG}>`) && !safeSource.includes(`</${FUNCTION_CALLS_TAG}>`)) {
            throw new Error(`Missing closing </${FUNCTION_CALLS_TAG}> tag.`);
        }
        return [];
    }

    const callBlocks = extractAllXmlTagBlocks(callsBlock.inner, FUNCTION_CALL_TAG);
    if (callBlocks.length === 0) {
        if (callsBlock.inner.includes(`<${FUNCTION_CALL_TAG}>`) && !callsBlock.inner.includes(`</${FUNCTION_CALL_TAG}>`)) {
            throw new Error(`Missing closing </${FUNCTION_CALL_TAG}> tag.`);
        }
        throw new Error(`No <${FUNCTION_CALL_TAG}> blocks found inside <${FUNCTION_CALLS_TAG}>.`);
    }

    const calls = [];
    for (let index = 0; index < callBlocks.length; index += 1) {
        const block = callBlocks[index];
        const toolBlock = extractXmlTagBlock(block.inner, TOOL_TAG);
        if (!toolBlock) {
            throw new Error(`Tool call #${index + 1} is missing <${TOOL_TAG}>.`);
        }

        const name = normalizeToolName(decodeXmlText(toolBlock.inner));
        if (!name) {
            throw new Error(`Tool call #${index + 1} has empty <${TOOL_TAG}>.`);
        }
        if (allowSet && !allowSet.has(name)) {
            continue;
        }

        const argsJsonBlock = extractXmlTagBlock(block.inner, ARGS_JSON_TAG);
        if (!argsJsonBlock) {
            throw new Error(`Tool call '${name}' is missing <${ARGS_JSON_TAG}>.`);
        }

        calls.push({
            id: '',
            name,
            args: parseArgsJsonPayload(argsJsonBlock.inner, name),
        });
    }

    return calls;
}

export function extractAllFunctionCalls(responseData, allowedNames = null) {
    const toolCalls = responseData?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        throw new Error('Model did not return any tool call.');
    }

    const allowSet = normalizeAllowedNameSet(allowedNames);
    const parsedCalls = [];
    for (const call of toolCalls) {
        const fnName = normalizeToolName(call?.function?.name);
        if (!fnName) {
            continue;
        }
        if (allowSet && !allowSet.has(fnName)) {
            continue;
        }
        const argsText = call?.function?.arguments;
        if (typeof argsText !== 'string' || !argsText.trim()) {
            throw new Error(`Tool call '${fnName}' arguments are empty.`);
        }
        try {
            const parsedArgs = JSON.parse(argsText);
            if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
                throw new Error();
            }
            parsedCalls.push({
                id: String(call?.id || ''),
                name: fnName,
                args: parsedArgs,
            });
        } catch {
            throw new Error(`Tool call '${fnName}' arguments are not valid JSON.`);
        }
    }
    if (parsedCalls.length === 0) {
        throw new Error('Model returned tool calls, but none matched expected function names.');
    }
    return parsedCalls;
}

export function extractFunctionCallArguments(responseData, functionName) {
    const expectedName = normalizeToolName(functionName);
    if (!expectedName) {
        throw new Error('Function name is required.');
    }
    const calls = extractAllFunctionCalls(responseData, [expectedName]);
    const matchedCall = calls.find(call => normalizeToolName(call?.name) === expectedName);
    if (!matchedCall) {
        throw new Error(`Model returned tool call, but not '${expectedName}'.`);
    }
    return matchedCall.args;
}

export function extractToolCallsFromResponse(responseData, allowedNames = null) {
    try {
        return extractAllFunctionCalls(responseData, allowedNames).map(call => ({
            name: call.name,
            args: call.args,
        }));
    } catch {
        return [];
    }
}

export function extractAllFunctionCallsFromText(responseData, allowedNames = null, options = null) {
    const content = getResponseMessageContent(responseData);
    if (!content) {
        throw new Error('Model returned empty text response.');
    }

    const opts = options && typeof options === 'object' ? options : {};
    const triggerSignal = String(opts.triggerSignal || '').trim();
    const triggerRequired = Boolean(opts.triggerRequired);
    const allowSet = normalizeAllowedNameSet(allowedNames);

    const parseScopes = [];
    const triggerPos = triggerSignal ? findLastTriggerSignalOutsideThought(content, triggerSignal) : -1;
    if (triggerSignal && triggerPos >= 0) {
        const afterTrigger = content.slice(triggerPos + triggerSignal.length).trim();
        if (afterTrigger) {
            parseScopes.push(afterTrigger);
        }
    } else if (triggerSignal && triggerRequired) {
        throw new Error('Model text output did not include the required trigger signal.');
    }

    const strippedThought = stripThoughtBlocks(content).trim();
    if (strippedThought) {
        parseScopes.push(strippedThought);
    }
    parseScopes.push(content);

    const uniqueScopes = [...new Set(parseScopes.filter(Boolean))];
    let lastError = null;

    for (const scope of uniqueScopes) {
        try {
            const xmlCalls = parseFunctionCallsFromXmlText(scope, allowSet);
            if (xmlCalls.length > 0) {
                return xmlCalls;
            }
        } catch (error) {
            lastError = error;
        }
    }

    if (lastError) {
        throw lastError;
    }
    throw new Error('Model text output did not contain parseable function-call XML.');
}

export function extractToolCallsFromTextResponse(responseData, allowedNames = null, options = null) {
    try {
        return extractAllFunctionCallsFromText(responseData, allowedNames, options).map(call => ({
            name: call.name,
            args: call.args,
        }));
    } catch {
        return [];
    }
}

export function extractDisplayTextFromPlainTextFunctionResponse(rawText, options = null) {
    const source = String(rawText || '').trim();
    if (!source) {
        return '';
    }

    const opts = options && typeof options === 'object' ? options : {};
    const triggerSignal = String(opts.triggerSignal || '').trim();
    if (triggerSignal) {
        const triggerPos = findLastTriggerSignalOutsideThought(source, triggerSignal);
        if (triggerPos >= 0) {
            return source.slice(0, triggerPos).trim();
        }
    }

    const xmlBlocks = extractAllXmlTagBlocks(source, FUNCTION_CALLS_TAG);
    for (let index = xmlBlocks.length - 1; index >= 0; index -= 1) {
        const block = xmlBlocks[index];
        const suffix = source.slice(block.start).trim();
        if (!suffix.startsWith(`<${FUNCTION_CALLS_TAG}>`)) {
            continue;
        }
        return source.slice(0, block.start).trim();
    }
    return source;
}

function getPlainTextFunctionCallDiagnosisScope(rawText, triggerSignal = '') {
    const source = String(rawText || '').trim();
    const trigger = String(triggerSignal || '').trim();
    if (!source) {
        return '';
    }

    if (trigger) {
        const triggerPos = findLastTriggerSignalOutsideThought(source, trigger);
        if (triggerPos >= 0) {
            const afterTrigger = source.slice(triggerPos + trigger.length).trim();
            if (afterTrigger) {
                return afterTrigger;
            }
        }
    }

    return stripThoughtBlocks(source).trim() || source;
}

export function diagnosePlainTextFunctionCallError(responseData, options = null) {
    const content = getResponseMessageContent(responseData);
    if (!content) {
        return 'Model returned empty text response.';
    }

    const opts = options && typeof options === 'object' ? options : {};
    const triggerSignal = String(opts.triggerSignal || '').trim();
    const triggerRequired = Boolean(opts.triggerRequired);

    if (triggerSignal) {
        const triggerPos = findLastTriggerSignalOutsideThought(content, triggerSignal);
        if (triggerPos < 0) {
            return triggerRequired
                ? 'Model text output did not include the required trigger signal.'
                : 'No trigger signal found outside thought blocks.';
        }
    }

    const scope = getPlainTextFunctionCallDiagnosisScope(content, triggerSignal);
    if (!scope) {
        return 'Model text output did not contain parseable function-call XML.';
    }

    if (!scope.includes(`<${FUNCTION_CALLS_TAG}>`)) {
        return `Missing <${FUNCTION_CALLS_TAG}> tag after trigger signal.`;
    }
    if (!scope.includes(`</${FUNCTION_CALLS_TAG}>`)) {
        return `Missing closing </${FUNCTION_CALLS_TAG}> tag.`;
    }
    if (!scope.includes(`<${FUNCTION_CALL_TAG}>`)) {
        return `No <${FUNCTION_CALL_TAG}> blocks found inside <${FUNCTION_CALLS_TAG}>.`;
    }
    if (!scope.includes(`</${FUNCTION_CALL_TAG}>`)) {
        return `Missing closing </${FUNCTION_CALL_TAG}> tag.`;
    }

    const callsBlock = extractXmlTagBlock(scope, FUNCTION_CALLS_TAG);
    if (!callsBlock) {
        return `Malformed <${FUNCTION_CALLS_TAG}> block.`;
    }

    const firstCall = extractXmlTagBlock(callsBlock.inner, FUNCTION_CALL_TAG);
    if (!firstCall) {
        return `No <${FUNCTION_CALL_TAG}> blocks found inside <${FUNCTION_CALLS_TAG}>.`;
    }
    if (!extractXmlTagBlock(firstCall.inner, TOOL_TAG)) {
        return `Missing <${TOOL_TAG}> tag inside <${FUNCTION_CALL_TAG}>.`;
    }

    const argsJsonBlock = extractXmlTagBlock(firstCall.inner, ARGS_JSON_TAG);
    if (!argsJsonBlock) {
        return `Missing <${ARGS_JSON_TAG}> tag inside <${FUNCTION_CALL_TAG}>.`;
    }

    const rawPayload = decodeXmlText(unwrapCdata(argsJsonBlock.inner)).trim();
    if (!rawPayload) {
        return `<${ARGS_JSON_TAG}> must contain a JSON object.`;
    }

    try {
        const parsed = JSON.parse(rawPayload);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return `<${ARGS_JSON_TAG}> must decode to a JSON object.`;
        }
    } catch (error) {
        return error instanceof Error && error.message
            ? `Invalid JSON in <${ARGS_JSON_TAG}>: ${error.message}`
            : `Invalid JSON in <${ARGS_JSON_TAG}>.`;
    }

    return 'XML structure appears valid but function-call parsing still failed.';
}

function buildToolRows(tools) {
    const normalizedTools = normalizeTools(tools);
    return normalizedTools.map((tool) => {
        const name = normalizeToolName(tool?.function?.name);
        if (!name) {
            return null;
        }
        const description = String(tool?.function?.description || '').replace(/\s+/g, ' ').trim();
        const schema = normalizeSchemaFromTool(tool);
        const properties = schema?.properties && typeof schema.properties === 'object'
            ? Object.keys(schema.properties)
            : [];
        const required = Array.isArray(schema?.required)
            ? schema.required.map(field => String(field || '').trim()).filter(Boolean)
            : [];
        const optional = properties.filter(field => !required.includes(field));
        return {
            name,
            description,
            required,
            optional,
            schema,
        };
    }).filter(Boolean);
}

function buildToolProtocolGuide(rows, style) {
    if (style === TOOL_PROTOCOL_STYLE.JSON_SCHEMA) {
        return rows.map((row, index) => {
            const required = row.required.length > 0 ? row.required.join(', ') : '-';
            const optional = row.optional.length > 0 ? row.optional.join(', ') : '-';
            const detailBlock = buildHumanReadableParameterDetails(row.schema);
            return [
                `${index + 1}. <tool name="${escapeXmlText(row.name)}">`,
                `   Description: ${row.description || '-'}`,
                `   Required parameters: ${required}`,
                `   Optional parameters: ${optional}`,
                '   Parameter details:',
                detailBlock,
                '</tool>',
            ].join('\n');
        }).join('\n\n');
    }

    return rows.map((row, index) => {
        const required = row.required.length > 0 ? row.required.join(', ') : '-';
        const optional = row.optional.length > 0 ? row.optional.join(', ') : '-';
        return [
            `${index + 1}. <tool name="${escapeXmlText(row.name)}">`,
            `  <required_args>${escapeXmlText(required)}</required_args>`,
            `  <optional_args>${escapeXmlText(optional)}</optional_args>`,
            `  <purpose>${escapeXmlText(row.description || '-')}</purpose>`,
            '</tool>',
        ].join('\n');
    }).join('\n\n');
}

export function buildToolChoiceConstraintAddendum(toolChoice = 'auto', tools = []) {
    if (toolChoice === null || toolChoice === undefined || toolChoice === 'auto') {
        return '';
    }
    if (toolChoice === 'none') {
        return 'Tool-choice constraint: do NOT call any tool in this response.';
    }
    if (toolChoice === 'required') {
        return 'Tool-choice constraint: you MUST call at least one allowed tool in this response.';
    }

    const selectedName = normalizeToolName(
        toolChoice?.function?.name
        || (typeof toolChoice === 'object' ? toolChoice?.name : ''),
    );
    if (!selectedName) {
        return '';
    }
    const availableNames = new Set(buildToolRows(tools).map(tool => tool.name));
    if (availableNames.size > 0 && !availableNames.has(selectedName)) {
        return `Tool-choice constraint: requested tool '${selectedName}' is unavailable. Use only allowed tools.`;
    }
    return `Tool-choice constraint: call ONLY tool '${selectedName}' in this response.`;
}

export function isToolCallMandatory({ toolChoice = 'auto', requiredFunctionName = '' } = {}) {
    return String(toolChoice || '').trim() === 'required' || Boolean(normalizeToolName(requiredFunctionName));
}

/**
 * Resolve the requested function-call mode against the connection's plain-text setting.
 *
 * Semantics:
 *   - 'auto' (default): respect the plain-text setting — switch to 'prompt_xml' when enabled, else 'native'.
 *   - 'native': force native tool calling, ignoring the setting.
 *   - 'prompt_xml' / 'prompt_json': force the corresponding plain-text protocol, ignoring the setting.
 *   - empty / unknown: treated as 'auto'.
 *
 * @param {object} [options]
 * @param {'auto'|'native'|'prompt_xml'|'prompt_json'|string} [options.requestedMode='auto']
 * @param {boolean} [options.plainTextEnabled=false]
 * @returns {'native'|'prompt_xml'|'prompt_json'}
 */
export function resolveFunctionCallMode({ requestedMode = 'auto', plainTextEnabled = false } = {}) {
    const mode = String(requestedMode || '').trim().toLowerCase() || 'auto';
    if (mode === 'native' || mode === 'prompt_xml' || mode === 'prompt_json') {
        return mode;
    }
    return plainTextEnabled ? 'prompt_xml' : 'native';
}

export function buildPlainTextToolProtocolMessage(
    tools = [],
    {
        requiredFunctionName = '',
        style = TOOL_PROTOCOL_STYLE.TABLE,
        triggerSignal = '',
        toolChoice = 'auto',
    } = {},
) {
    const requiredName = normalizeToolName(requiredFunctionName);
    const rows = buildToolRows(tools);
    const requiredLine = requiredName ? `Required function name for this response: ${requiredName}.` : '';
    const trigger = String(triggerSignal || '').trim();
    const toolChoiceLine = buildToolChoiceConstraintAddendum(toolChoice, tools);
    const toolGuide = buildToolProtocolGuide(rows, style);
    const exampleTrigger = trigger || '<Function_AB1c_Start/>';
    return [
        'You have access to the following available tools to help solve problems:',
        '',
        toolGuide,
        '',
        'IMPORTANT CONTEXT NOTES:',
        '- You can call MULTIPLE tools in a single response if needed.',
        '- Even when multiple tools are allowed, you must still follow any later user or prompt constraint that forbids tools, requires a tool, or restricts you to one named tool.',
        '- The conversation context may already contain tool execution results from previous function calls. Review the conversation history carefully to avoid unnecessary duplicate tool calls.',
        '- When tool execution results are present in context, they may be wrapped in <tool_result>...</tool_result>.',
        '- If the current prompt requires a specific preamble format such as <thought>, follow that prompt before you emit the trigger signal.',
        requiredLine ? `- ${requiredLine}` : '',
        toolChoiceLine ? `- ${toolChoiceLine}` : '',
        '',
        'When you need to use tools, you MUST strictly follow this format:',
        trigger
            ? `1. When starting tool calls, begin on a new line with exactly:\n${trigger}`
            : `1. When starting tool calls, begin on a new line with exactly one <${FUNCTION_CALLS_TAG}> XML block.`,
        trigger ? 'No leading or trailing spaces. The trigger signal must be on its own line and appear only once.' : '',
        `2. Starting from the next line, immediately output the complete <${FUNCTION_CALLS_TAG}> XML block.`,
        `3. For multiple tool calls, include multiple <${FUNCTION_CALL_TAG}> blocks inside the same <${FUNCTION_CALLS_TAG}> wrapper. Do not emit separate wrappers.`,
        `4. Do not add any text or explanation after the closing </${FUNCTION_CALLS_TAG}> tag.`,
        '',
        'STRICT ARGUMENT KEY RULES:',
        '- You MUST use parameter keys EXACTLY as defined. Do not rename keys or change punctuation.',
        '- If a key contains punctuation or starts with a hyphen, keep it exactly as defined. Never change "-i" to "i" or "safe_search" to "safeSearch".',
        `- The <${TOOL_TAG}> tag must contain the exact name of a tool from the list. Any other tool name is invalid.`,
        `- The <${ARGS_JSON_TAG}> tag must contain one JSON object with all required arguments for that tool.`,
        `- Wrap the JSON object inside <![CDATA[...]]> within <${ARGS_JSON_TAG}> to avoid XML escaping issues.`,
        '',
        'CORRECT Example (multiple tool calls):',
        '...response content (optional)...',
        exampleTrigger,
        `<${FUNCTION_CALLS_TAG}>`,
        `    <${FUNCTION_CALL_TAG}>`,
        `        <${TOOL_TAG}>FUNCTION_A</${TOOL_TAG}>`,
        `        <${ARGS_JSON_TAG}><![CDATA[{"arg1":"value","safe_search":"moderate"}]]></${ARGS_JSON_TAG}>`,
        `    </${FUNCTION_CALL_TAG}>`,
        `    <${FUNCTION_CALL_TAG}>`,
        `        <${TOOL_TAG}>FUNCTION_B</${TOOL_TAG}>`,
        `        <${ARGS_JSON_TAG}><![CDATA[{"-i":true,"arg2":123}]]></${ARGS_JSON_TAG}>`,
        `    </${FUNCTION_CALL_TAG}>`,
        `</${FUNCTION_CALLS_TAG}>`,
        '',
        'INCORRECT Example (extra prose after trigger line; do not do this):',
        '...response content (optional)...',
        exampleTrigger,
        'I will call the tools for you now.',
        `<${FUNCTION_CALLS_TAG}>`,
        `    <${FUNCTION_CALL_TAG}>`,
        `        <${TOOL_TAG}>FUNCTION_A</${TOOL_TAG}>`,
        `        <${ARGS_JSON_TAG}><![CDATA[{"arg1":"value"}]]></${ARGS_JSON_TAG}>`,
        `    </${FUNCTION_CALL_TAG}>`,
        `</${FUNCTION_CALLS_TAG}>`,
        '',
        'INCORRECT Example (do not do this):',
        '...response content (optional)...',
        '```json',
        '{"tool_calls":[{"name":"FUNCTION_A","arguments":{"arg1":"value"}}]}',
        '```',
        '',
        'Now strictly follow the above specifications.',
    ].filter(Boolean).join('\n');
}

export function buildStrictFunctionCallOutputAddendum({
    plainTextMode = false,
    requiredFunctionName = '',
    triggerSignal = '',
} = {}) {
    const requiredName = normalizeToolName(requiredFunctionName);
    const trigger = String(triggerSignal || '').trim();
    return [
        'HIGHEST PRIORITY OUTPUT CONTRACT:',
        'You may optionally output text before the function-call payload.',
        'If the current prompt requires a specific preamble format such as <thought>, follow that prompt. Otherwise the preamble text is optional.',
        plainTextMode
            ? (trigger
                ? `When you start the function-call payload, first output this trigger line on its own line: ${trigger}`
                : `When you start the function-call payload, output one <${FUNCTION_CALLS_TAG}> XML block immediately.`)
            : 'Return function calls only (tool-calls channel).',
        plainTextMode
            ? `Then immediately output exactly one <${FUNCTION_CALLS_TAG}> XML block containing one or more <${FUNCTION_CALL_TAG}> children.`
            : '',
        plainTextMode
            ? `Each <${FUNCTION_CALL_TAG}> must contain <${TOOL_TAG}>TOOL_NAME</${TOOL_TAG}> and <${ARGS_JSON_TAG}><![CDATA[{...}]]></${ARGS_JSON_TAG}>.`
            : '',
        plainTextMode ? 'Multiple tool calls in one response are valid and recommended when needed.' : '',
        requiredName ? `Required function name: ${requiredName}.` : '',
        'Do NOT output any extra text after the function payload.',
        'Forbidden after or around the payload: markdown code fences, comments, duplicate payloads, or JSON tool_calls objects.',
        'After function calls, stop immediately.',
    ].filter(Boolean).join('\n');
}

export function buildStrictThoughtAndFunctionOnlyAddendum(options = {}) {
    return buildStrictFunctionCallOutputAddendum(options);
}

export function buildFunctionCallRetryAddendum({
    rawResponse = '',
    errorDetails = '',
    triggerSignal = '',
    requiredFunctionName = '',
    plainTextMode = true,
} = {}) {
    const preview = String(rawResponse || '').trim().slice(0, 2000);
    const error = String(errorDetails || 'Unknown parse error').trim();
    const required = normalizeToolName(requiredFunctionName);
    const trigger = String(triggerSignal || '').trim();

    return [
        'Your previous response attempted function calling but failed parsing/validation.',
        `Error details: ${error}`,
        preview ? `Previous response preview:\n\`\`\`\n${preview}\n\`\`\`` : '',
        'Retry now with strictly valid output only.',
        'Common invalid patterns to avoid:',
        '- extra prose between the trigger line and <function_calls>',
        '- renamed or malformed argument keys',
        '- markdown fences or JSON tool_calls wrappers',
        '- duplicate trigger lines or multiple <function_calls> wrappers',
        trigger ? `First line must be exactly: ${trigger}` : '',
        plainTextMode
            ? `Then immediately output exactly one <${FUNCTION_CALLS_TAG}> XML block containing one or more <${FUNCTION_CALL_TAG}> children.`
            : 'Then output tool calls only.',
        plainTextMode
            ? `Use <${TOOL_TAG}> for the tool name and <${ARGS_JSON_TAG}><![CDATA[{...}]]></${ARGS_JSON_TAG}> for arguments.`
            : '',
        plainTextMode
            ? [
                'Correct skeleton:',
                trigger || '<Function_AB1c_Start/>',
                `<${FUNCTION_CALLS_TAG}>`,
                `  <${FUNCTION_CALL_TAG}>`,
                `    <${TOOL_TAG}>TOOL_NAME</${TOOL_TAG}>`,
                `    <${ARGS_JSON_TAG}><![CDATA[{"arg":"value"}]]></${ARGS_JSON_TAG}>`,
                `  </${FUNCTION_CALL_TAG}>`,
                `</${FUNCTION_CALLS_TAG}>`,
            ].join('\n')
            : '',
        required ? `Required function name: ${required}.` : '',
        'Do not output any extra prose after the function payload.',
    ].filter(Boolean).join('\n');
}

export function mergeUserAddendumIntoPromptMessages(promptMessages, addendumText, tagOptions = null) {
    const messages = Array.isArray(promptMessages)
        ? promptMessages.map(message => ({ ...message }))
        : [];
    const addendum = String(addendumText || '').trim();
    if (!addendum) {
        return messages;
    }
    const options = typeof tagOptions === 'string'
        ? { tagName: tagOptions, wrapWithTag: true }
        : (tagOptions && typeof tagOptions === 'object' ? tagOptions : {});
    const wrapWithTag = Boolean(options?.wrapWithTag);
    const tag = String(options?.tagName || '').trim() || 'function_call_protocol';
    const payload = wrapWithTag
        ? [`<${tag}>`, addendum, `</${tag}>`].join('\n')
        : addendum;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (String(message?.role || '').toLowerCase() !== 'user') {
            continue;
        }
        const base = typeof message?.content === 'string'
            ? message.content
            : String(message?.content ?? '');
        messages[index] = {
            ...message,
            content: base ? `${base}\n\n${payload}` : payload,
        };
        return messages;
    }

    messages.push({ role: 'user', content: payload });
    return messages;
}

export function mergeSystemAddendumIntoPromptMessages(promptMessages, addendumText, tagOptions = null) {
    const messages = Array.isArray(promptMessages)
        ? promptMessages.map(message => ({ ...message }))
        : [];
    const addendum = String(addendumText || '').trim();
    if (!addendum) {
        return messages;
    }
    const options = typeof tagOptions === 'string'
        ? { tagName: tagOptions, wrapWithTag: true }
        : (tagOptions && typeof tagOptions === 'object' ? tagOptions : {});
    const wrapWithTag = Boolean(options?.wrapWithTag);
    const tag = String(options?.tagName || '').trim() || 'function_call_protocol';
    const payload = wrapWithTag
        ? [`<${tag}>`, addendum, `</${tag}>`].join('\n')
        : addendum;

    let insertIndex = 0;
    while (insertIndex < messages.length && String(messages[insertIndex]?.role || '').toLowerCase() === 'system') {
        insertIndex += 1;
    }

    messages.splice(insertIndex, 0, { role: 'system', content: payload });
    return messages;
}

function schemaTypeName(value) {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    if (typeof value === 'string') return 'string';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return 'object';
    return typeof value;
}

function validateValueAgainstSchema(value, schema, path = 'args', depth = 0) {
    const safeSchema = schema && typeof schema === 'object' ? schema : {};
    const errors = [];
    if (depth > 8) {
        return errors;
    }

    if (Array.isArray(safeSchema.allOf)) {
        for (let index = 0; index < safeSchema.allOf.length; index += 1) {
            errors.push(...validateValueAgainstSchema(value, safeSchema.allOf[index], `${path}.allOf[${index}]`, depth + 1));
        }
        return errors;
    }

    if (Array.isArray(safeSchema.anyOf)) {
        const result = safeSchema.anyOf.map(item => validateValueAgainstSchema(value, item, path, depth + 1));
        if (!result.some(item => item.length === 0)) {
            errors.push(`${path}: value does not satisfy anyOf options`);
        }
        return errors;
    }

    if (Array.isArray(safeSchema.oneOf)) {
        const result = safeSchema.oneOf.map(item => validateValueAgainstSchema(value, item, path, depth + 1));
        const matchCount = result.filter(item => item.length === 0).length;
        if (matchCount !== 1) {
            errors.push(`${path}: value must satisfy exactly one oneOf option (matched ${matchCount})`);
        }
        return errors;
    }

    if (Object.hasOwn(safeSchema, 'const') && value !== safeSchema.const) {
        errors.push(`${path}: expected const=${JSON.stringify(safeSchema.const)}, got ${JSON.stringify(value)}`);
        return errors;
    }

    if (Array.isArray(safeSchema.enum) && !safeSchema.enum.includes(value)) {
        errors.push(`${path}: expected one of ${JSON.stringify(safeSchema.enum)}, got ${JSON.stringify(value)}`);
        return errors;
    }

    let expectedType = safeSchema.type;
    if (!expectedType && (safeSchema.properties || safeSchema.required || Object.hasOwn(safeSchema, 'additionalProperties'))) {
        expectedType = 'object';
    }

    const typeCheck = (typeName) => {
        if (typeName === 'object') return value && typeof value === 'object' && !Array.isArray(value);
        if (typeName === 'array') return Array.isArray(value);
        if (typeName === 'string') return typeof value === 'string';
        if (typeName === 'boolean') return typeof value === 'boolean';
        if (typeName === 'integer') return Number.isInteger(value);
        if (typeName === 'number') return typeof value === 'number';
        if (typeName === 'null') return value === null;
        return true;
    };

    if (typeof expectedType === 'string') {
        if (!typeCheck(expectedType)) {
            errors.push(`${path}: expected type '${expectedType}', got '${schemaTypeName(value)}'`);
            return errors;
        }
    } else if (Array.isArray(expectedType)) {
        if (!expectedType.some(typeName => typeCheck(typeName))) {
            errors.push(`${path}: expected type in ${JSON.stringify(expectedType)}, got '${schemaTypeName(value)}'`);
            return errors;
        }
    }

    if (typeof value === 'string') {
        if (Number.isInteger(safeSchema.minLength) && value.length < safeSchema.minLength) {
            errors.push(`${path}: string shorter than minLength=${safeSchema.minLength}`);
        }
        if (Number.isInteger(safeSchema.maxLength) && value.length > safeSchema.maxLength) {
            errors.push(`${path}: string longer than maxLength=${safeSchema.maxLength}`);
        }
        if (typeof safeSchema.pattern === 'string') {
            try {
                if (!new RegExp(safeSchema.pattern).test(value)) {
                    errors.push(`${path}: string does not match pattern ${safeSchema.pattern}`);
                }
            } catch {
                // Ignore invalid schema regex.
            }
        }
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const properties = safeSchema.properties && typeof safeSchema.properties === 'object'
            ? safeSchema.properties
            : {};
        const required = Array.isArray(safeSchema.required)
            ? safeSchema.required.filter(item => typeof item === 'string')
            : [];
        const additional = Object.hasOwn(safeSchema, 'additionalProperties')
            ? safeSchema.additionalProperties
            : true;

        for (const key of required) {
            if (!Object.hasOwn(value, key)) {
                errors.push(`${path}: missing required property '${key}'`);
            }
        }
        for (const [key, childValue] of Object.entries(value)) {
            if (Object.hasOwn(properties, key)) {
                errors.push(...validateValueAgainstSchema(childValue, properties[key], `${path}.${key}`, depth + 1));
                continue;
            }
            if (additional === false) {
                errors.push(`${path}: unexpected property '${key}'`);
                continue;
            }
            if (additional && typeof additional === 'object') {
                errors.push(...validateValueAgainstSchema(childValue, additional, `${path}.${key}`, depth + 1));
            }
        }
    }

    if (Array.isArray(value)) {
        if (Number.isInteger(safeSchema.minItems) && value.length < safeSchema.minItems) {
            errors.push(`${path}: array shorter than minItems=${safeSchema.minItems}`);
        }
        if (Number.isInteger(safeSchema.maxItems) && value.length > safeSchema.maxItems) {
            errors.push(`${path}: array longer than maxItems=${safeSchema.maxItems}`);
        }
        if (safeSchema.uniqueItems === true) {
            const seen = new Set(value.map(item => JSON.stringify(item)));
            if (seen.size !== value.length) {
                errors.push(`${path}: array contains duplicate items but uniqueItems=true`);
            }
        }
        if (safeSchema.items && typeof safeSchema.items === 'object') {
            for (let index = 0; index < value.length; index += 1) {
                errors.push(...validateValueAgainstSchema(value[index], safeSchema.items, `${path}[${index}]`, depth + 1));
            }
        }
    }

    return errors;
}

export function validateParsedToolCalls(parsedCalls = [], tools = []) {
    const safeTools = normalizeTools(tools);
    if (safeTools.length === 0) {
        return null;
    }
    const schemaByName = new Map();
    for (const tool of safeTools) {
        const name = normalizeToolName(tool?.function?.name);
        if (!name) {
            continue;
        }
        schemaByName.set(name, normalizeSchemaFromTool(tool));
    }
    if (schemaByName.size === 0) {
        return null;
    }

    const safeCalls = Array.isArray(parsedCalls) ? parsedCalls : [];
    for (let index = 0; index < safeCalls.length; index += 1) {
        const call = safeCalls[index] || {};
        const name = normalizeToolName(call.name);
        const args = call.args;

        if (!name) {
            return `Tool call #${index + 1}: missing tool name.`;
        }
        if (!schemaByName.has(name)) {
            return `Tool call #${index + 1}: unknown tool '${name}'.`;
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return `Tool call #${index + 1} '${name}': arguments must be a JSON object.`;
        }
        const schema = schemaByName.get(name) || {};
        const errors = validateValueAgainstSchema(args, schema, name);
        if (errors.length > 0) {
            return `Tool call #${index + 1} '${name}': schema validation failed: ${errors.slice(0, 6).join('; ')}`;
        }
    }

    return null;
}

export function buildToolCallIndexFromMessages(messages = []) {
    const index = {};
    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || typeof message !== 'object') {
            continue;
        }
        if (String(message.role || '') !== 'assistant') {
            continue;
        }
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        for (const call of toolCalls) {
            const id = String(call?.id || '').trim();
            const name = normalizeToolName(call?.function?.name);
            const args = call?.function?.arguments;
            if (!id || !name) {
                continue;
            }
            let argsText = '{}';
            if (typeof args === 'string') {
                argsText = args;
            } else if (args && typeof args === 'object') {
                try {
                    argsText = JSON.stringify(args);
                } catch {
                    argsText = String(args);
                }
            }
            index[id] = { name, arguments: argsText };
        }
    }
    return index;
}

export function formatToolResultForModel(toolName, toolArguments, resultContent, { resultTag = 'tool_result' } = {}) {
    return [
        'Tool execution result:',
        `- Tool name: ${String(toolName || '')}`,
        `- Tool arguments: ${String(toolArguments || '{}')}`,
        '- Execution result:',
        `<${resultTag}>`,
        String(resultContent || ''),
        `</${resultTag}>`,
    ].join('\n');
}

function normalizeToolArgumentsText(toolArguments) {
    if (toolArguments && typeof toolArguments === 'object' && !Array.isArray(toolArguments)) {
        return JSON.stringify(toolArguments);
    }
    if (typeof toolArguments === 'string' && toolArguments.trim()) {
        const parsed = JSON.parse(toolArguments);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Tool arguments must decode to a JSON object.');
        }
        return JSON.stringify(parsed);
    }
    return '{}';
}

export function formatToolCallForModel(toolName, toolArguments) {
    const normalizedName = normalizeToolName(toolName);
    const normalizedArguments = normalizeToolArgumentsText(toolArguments);
    return [
        `<${FUNCTION_CALL_TAG}>`,
        `  <${TOOL_TAG}>${escapeXmlText(normalizedName)}</${TOOL_TAG}>`,
        `  <${ARGS_JSON_TAG}>${wrapCdata(normalizedArguments)}</${ARGS_JSON_TAG}>`,
        `</${FUNCTION_CALL_TAG}>`,
    ].join('\n');
}

export function normalizeToolMessagesForPlainTextFunctionCalling(messages = [], options = {}) {
    const toolResultTag = String(options?.resultTag || 'tool_result');
    const triggerSignal = String(options?.triggerSignal || '').trim();
    const index = buildToolCallIndexFromMessages(messages);
    const output = [];
    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || typeof message !== 'object') {
            continue;
        }
        const role = String(message.role || '').trim().toLowerCase();
        const next = { ...message };
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

        if (toolCalls.length > 0) {
            const serializedCalls = toolCalls.map((toolCall) => {
                const toolName = normalizeToolName(toolCall?.function?.name);
                if (!toolName) {
                    return '';
                }
                return formatToolCallForModel(toolName, toolCall?.function?.arguments);
            }).filter(Boolean);

            const xmlPayload = [
                triggerSignal,
                `<${FUNCTION_CALLS_TAG}>`,
                ...serializedCalls,
                `</${FUNCTION_CALLS_TAG}>`,
            ].filter(Boolean).join('\n');

            next.content = [String(next.content ?? '').trim(), xmlPayload]
                .filter(Boolean)
                .join('\n\n');
            delete next.tool_calls;
        }

        if (role !== 'tool') {
            delete next.tool_call_id;
            output.push(next);
            continue;
        }

        const toolCallId = String(message.tool_call_id || '').trim();
        const toolInfo = index[toolCallId];
        output.push({
            role: 'user',
            content: toolInfo
                ? formatToolResultForModel(
                    toolInfo.name,
                    toolInfo.arguments,
                    message.content ?? '',
                    { resultTag: toolResultTag },
                )
                : String(message.content ?? ''),
        });
    }
    return output;
}
