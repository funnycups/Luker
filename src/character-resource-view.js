import { parser } from '@lezer/json';

import { compare } from '../public/scripts/util/fast-json-patch.js';

/**
 * Segments a character card JSON string without changing any source text.
 *
 * Field boundaries follow the card's storage shape: root properties, direct
 * `data` properties, and the direct namespaces of `data.extensions`. Values
 * outside those boundaries stay inside their parent field, so a large embedded
 * book or a plugin namespace is still one independently cacheable resource.
 *
 * @param {{raw: string, account?: string, avatar?: string}} input
 * @returns {{rawLayout: Array<string|{literal: string}|{path: string}>, fields: string[], values: Map<string,string>}}
 */
export function buildCharacterSourceView({ raw }) {
    if (typeof raw !== 'string' || raw.length === 0) {
        throw resourceError('invalid_resource', 'Character source is empty.');
    }

    try {
        JSON.parse(raw);
    } catch (error) {
        throw resourceError('invalid_resource', `Character source is not valid JSON: ${error.message}`);
    }

    const tree = parser.parse(raw);
    const root = tree.topNode.firstChild;
    if (!root || root.name !== 'Object') {
        throw resourceError('invalid_resource', 'Character source root must be a JSON object.');
    }

    const values = new Map();
    const rawLayout = buildObjectLayout({ raw, node: root, prefix: '', level: 'root', values });
    if (root.from > 0) {
        rawLayout.unshift(raw.slice(0, root.from));
    }
    if (root.to < raw.length) {
        rawLayout.push(raw.slice(root.to));
    }
    return { rawLayout, fields: [...values.keys()], values };
}

/**
 * Builds the patch between the raw card object and the existing runtime
 * character object. `json_data` is intentionally not part of the patch: the
 * client restores it from the lossless raw layout.
 *
 * @param {{raw: string, character: object}} input
 * @returns {{patch: object[], keyOrder: string[]}}
 */
export function buildCharacterProjection({ raw, character }) {
    const parsed = JSON.parse(raw);
    const runtime = { ...character };
    delete runtime.json_data;
    return {
        patch: compare(parsed, runtime),
        keyOrder: Object.keys(character),
    };
}

/**
 * Joins a previously served layout with field values. Missing fields are a
 * source conflict, never an empty-string fallback.
 *
 * @param {Array<string|{literal: string}|{path: string}>} rawLayout
 * @param {Map<string,string>} values
 * @returns {string}
 */
export function assembleCharacterRaw(rawLayout, values) {
    if (!Array.isArray(rawLayout)) {
        throw resourceError('invalid_resource', 'Character layout must be an array.');
    }
    let result = '';
    for (const part of rawLayout) {
        if (typeof part === 'string') {
            result += part;
            continue;
        }
        if (!part || typeof part !== 'object') {
            throw resourceError('invalid_resource', 'Character layout contains an invalid part.');
        }
        if (Object.prototype.hasOwnProperty.call(part, 'literal')) {
            result += String(part.literal);
            continue;
        }
        if (typeof part.path !== 'string' || !values.has(part.path)) {
            throw resourceError('read_conflict', `Missing character field ${part?.path ?? '<unknown>'}.`);
        }
        result += values.get(part.path);
    }
    return result;
}

function buildObjectLayout({ raw, node, prefix, level, values }) {
    const properties = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'Property') {
            properties.push(child);
        }
    }

    const lastIndexByKey = new Map();
    const decoded = properties.map((property, index) => {
        const keyNode = property.firstChild;
        const valueNode = property.lastChild;
        let key;
        try {
            key = JSON.parse(raw.slice(keyNode.from, keyNode.to));
        } catch (error) {
            throw resourceError('invalid_resource', `Invalid property name at ${keyNode.from}: ${error.message}`);
        }
        lastIndexByKey.set(key, index);
        return { property, keyNode, valueNode, key };
    });

    const parts = [];
    let cursor = node.from;
    for (let index = 0; index < decoded.length; index++) {
        const { valueNode, key } = decoded[index];
        if (lastIndexByKey.get(key) !== index) {
            continue;
        }

        const path = `${prefix}/${escapeJsonPointer(key)}`;
        const descendData = level === 'root' && key === 'data' && valueNode.name === 'Object';
        const descendExtensions = level === 'data' && key === 'extensions' && valueNode.name === 'Object';

        if (!descendData && !descendExtensions) {
            parts.push(raw.slice(cursor, valueNode.from));
            parts.push({ path });
            values.set(path, raw.slice(valueNode.from, valueNode.to));
            cursor = valueNode.to;
            continue;
        }

        parts.push(raw.slice(cursor, valueNode.from));
        parts.push(...buildObjectLayout({
            raw,
            node: valueNode,
            prefix: descendData ? '/data' : '/data/extensions',
            level: descendData ? 'data' : 'extensions',
            values,
        }));
        cursor = valueNode.to;
    }
    parts.push(raw.slice(cursor, node.to));
    return parts;
}

function escapeJsonPointer(value) {
    return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function resourceError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}
