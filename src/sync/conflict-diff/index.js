/**
 * Entry point for the structured conflict view.
 *
 * The diff route receives the navigation tree only. Value text stays in
 * resolvers keyed by node id; the value route rebuilds the same
 * deterministic tree and asks one resolver for one page.
 */

import path from 'node:path';
import extract from 'png-chunks-extract';

import * as characterCard from '../../character-card-parser.js';
import { createBuilder } from './tree.js';
import { cellPage, pageLines } from './values.js';
import { renderPreset } from './preset.js';
import { renderWorldBook } from './worldbook.js';
import { renderCharacter } from './character-card.js';
import { parseChat, renderChat } from './chat.js';
import { renderSecrets } from './secrets.js';
import { renderGeneric } from './generic.js';
import { renderText } from './text.js';

const TEXT_EXTENSIONS = new Set(['.json', '.jsonl', '.txt', '.md', '.yaml', '.yml', '.css', '.js']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function normalizedPath(relPath) {
    return String(relPath).replaceAll('\\', '/');
}

function basenameOf(relPath) {
    return path.posix.basename(normalizedPath(relPath)).toLowerCase();
}

function extensionOf(relPath) {
    return path.posix.extname(normalizedPath(relPath)).toLowerCase();
}

function parseJson(bytes) {
    if (!bytes) return null;
    try {
        const value = JSON.parse(bytes.toString('utf8'));
        return value && typeof value === 'object' ? value : null;
    } catch {
        return null;
    }
}

function isPreset(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
    const prompts = document.prompts;
    const hasPrompts = Array.isArray(prompts) || (prompts && typeof prompts === 'object');
    return Boolean(hasPrompts) && Object.hasOwn(document, 'prompt_order');
}

function isWorldBook(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
    const entries = document.entries;
    if (entries === undefined) return false;
    const list = Array.isArray(entries) ? entries : (entries && typeof entries === 'object' ? Object.values(entries) : null);
    if (list === null) return false;
    return list.length === 0 || list.every(entry => entry && typeof entry === 'object' && Object.hasOwn(entry, 'uid'));
}

function isCharacter(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
    if (document.spec === 'chara_card_v2' && document.data) return true;
    if (document.data && typeof document.data === 'object') {
        return Boolean(document.data.name || document.data.first_mes || document.data.description);
    }
    return typeof document.name === 'string'
        && (typeof document.description === 'string' || typeof document.personality === 'string' || typeof document.first_mes === 'string');
}

function isPresetPath(relPath) {
    return /(^|\/)(OpenAI Settings|TextGeneration Settings)\//.test(normalizedPath(relPath));
}

function isWorldPath(relPath) {
    return /(^|\/)worlds\//.test(normalizedPath(relPath));
}

function hasCardChunk(bytes) {
    try {
        return extract(bytes).some(chunk => {
            if (chunk.name !== 'tEXt') return false;
            const separator = chunk.data.indexOf(0);
            if (separator < 0) return false;
            const keyword = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, separator).toString('latin1').toLowerCase();
            return keyword === 'chara' || keyword === 'ccv3';
        });
    } catch {
        return false;
    }
}

function cardDocument(bytes) {
    if (!bytes || !hasCardChunk(bytes)) return null;
    try {
        const value = JSON.parse(characterCard.read(bytes));
        return value && typeof value === 'object' ? value : null;
    } catch {
        return null;
    }
}

/** True when everything outside the embedded card chunks is identical. */
function pngImageDiffers(left, right) {
    try {
        return !characterCard.stripCharacterMetadata(left).equals(characterCard.stripCharacterMetadata(right));
    } catch {
        return true;
    }
}

function detectKind(relPath, left, right) {
    const name = basenameOf(relPath);
    const extension = extensionOf(relPath);

    if (name === 'secrets.json') return { kind: 'secrets' };

    if (extension === '.png' && normalizedPath(relPath).startsWith('characters/')) {
        const leftDocument = cardDocument(left);
        const rightDocument = cardDocument(right);
        const readable = (!left || leftDocument) && (!right || rightDocument);
        if (readable && (leftDocument || rightDocument)) return { kind: 'character', leftDocument, rightDocument };
        return { kind: 'image' };
    }

    if (IMAGE_EXTENSIONS.has(extension)) return { kind: 'image' };

    if (extension === '.jsonl') {
        const leftChat = left ? parseChat(left.toString('utf8')) : null;
        const rightChat = right ? parseChat(right.toString('utf8')) : null;
        if ((!left || leftChat) && (!right || rightChat)) return { kind: 'chat' };
        return { kind: 'text' };
    }

    if (extension === '.json') {
        const leftDocument = left ? parseJson(left) : null;
        const rightDocument = right ? parseJson(right) : null;
        if ((left && !leftDocument) || (right && !rightDocument)) return { kind: 'text' };
        const document = rightDocument ?? leftDocument;
        if (!document) return { kind: 'text' };
        if (isPreset(document) || isPresetPath(relPath)) return { kind: 'preset', leftDocument, rightDocument };
        if (isWorldBook(document) || isWorldPath(relPath)) return { kind: 'worldbook', leftDocument, rightDocument };
        if (isCharacter(document) || normalizedPath(relPath).startsWith('characters/')) return { kind: 'character', leftDocument, rightDocument };
        if (name === 'settings.json') return { kind: 'settings', leftDocument, rightDocument };
        return { kind: 'json', leftDocument, rightDocument };
    }

    if (TEXT_EXTENSIONS.has(extension)) return { kind: 'text' };
    return { kind: 'binary' };
}

function totalChanges(sections) {
    return sections.reduce((sum, section) => sum + section.meta.leaves, 0);
}

function emptyView(kind, leftSize, rightSize) {
    return {
        kind,
        identical: false,
        deleted: null,
        unreadable: false,
        imageDiffers: false,
        leftSize,
        rightSize,
        totalChanges: 0,
        sections: [],
    };
}

/**
 * @param {{ path: string, left: Buffer | null, right: Buffer | null }} args
 * @returns {{ view: object, values: Map<string, () => object> }}
 */
export function buildConflictView({ path: relPath, left, right }) {
    const leftBytes = left ?? null;
    const rightBytes = right ?? null;
    const leftSize = leftBytes ? leftBytes.length : 0;
    const rightSize = rightBytes ? rightBytes.length : 0;
    const detected = detectKind(relPath, leftBytes, rightBytes);
    const base = emptyView(detected.kind, leftSize, rightSize);

    if (leftBytes && rightBytes && leftBytes.equals(rightBytes)) {
        return { view: { ...base, identical: true }, values: new Map() };
    }
    if (!leftBytes || !rightBytes) {
        return { view: { ...base, deleted: leftBytes ? 'right' : 'left' }, values: new Map() };
    }

    if (detected.kind === 'secrets') {
        const leftDocument = parseJson(leftBytes);
        const rightDocument = parseJson(rightBytes);
        if (leftDocument === null || rightDocument === null) {
            return { view: { ...base, unreadable: true }, values: new Map() };
        }
        const builder = createBuilder();
        const finalized = builder.finalize(renderSecrets(leftDocument, rightDocument, builder));
        return {
            view: { ...base, totalChanges: totalChanges(finalized.sections), sections: finalized.sections },
            values: finalized.values,
        };
    }

    if (detected.kind === 'image' || detected.kind === 'binary') {
        const characterImage = extensionOf(relPath) === '.png' && normalizedPath(relPath).startsWith('characters/');
        const imageDiffers = detected.kind === 'image'
            && (!characterImage || pngImageDiffers(leftBytes, rightBytes));
        return { view: { ...base, imageDiffers }, values: new Map() };
    }

    const builder = createBuilder();
    let sections = [];
    let kind = detected.kind;
    let imageDiffers = false;

    switch (detected.kind) {
        case 'preset':
            sections = renderPreset(detected.leftDocument, detected.rightDocument, builder);
            break;
        case 'worldbook':
            sections = renderWorldBook(detected.leftDocument, detected.rightDocument, builder);
            break;
        case 'character':
            sections = renderCharacter(detected.leftDocument, detected.rightDocument, builder);
            imageDiffers = extensionOf(relPath) === '.png' ? pngImageDiffers(leftBytes, rightBytes) : false;
            break;
        case 'chat': {
            const leftText = leftBytes.toString('utf8');
            const rightText = rightBytes.toString('utf8');
            const chatSections = renderChat(leftText, rightText, builder);
            if (chatSections === null) {
                sections = renderText(leftText, rightText, builder);
                kind = 'text';
            } else {
                sections = chatSections;
            }
            break;
        }
        case 'settings':
        case 'json':
            sections = renderGeneric(detected.leftDocument, detected.rightDocument, builder);
            break;
        case 'text':
            sections = renderText(leftBytes.toString('utf8'), rightBytes.toString('utf8'), builder);
            break;
        default:
            break;
    }

    const finalized = builder.finalize(sections);
    return {
        view: {
            ...base,
            kind,
            imageDiffers,
            totalChanges: totalChanges(finalized.sections),
            sections: finalized.sections,
        },
        values: finalized.values,
    };
}

function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

/**
 * @param {{ path: string, left: Buffer | null, right: Buffer | null, nodeId: string, offset?: number }} args
 */
export function readConflictValue({ path: relPath, left, right, nodeId, offset = 0 }) {
    if (!Number.isInteger(offset) || offset < 0) throw codedError('INVALID_OFFSET', 'The value offset must be a non-negative integer.');
    const { values } = buildConflictView({ path: relPath, left, right });
    const resolver = values.get(String(nodeId));
    if (!resolver) throw codedError('UNKNOWN_NODE', 'The requested conflict node does not exist.');
    const source = resolver();
    if (source.mode === 'lines') {
        const page = pageLines(source.rows, offset);
        return {
            nodeId: String(nodeId),
            mode: 'lines',
            rows: page.rows,
            rowTotal: page.rowTotal,
            offset,
            nextOffset: page.nextOffset,
        };
    }
    const before = cellPage(source.before, offset);
    const after = cellPage(source.after, offset);
    return {
        nodeId: String(nodeId),
        mode: 'cells',
        before,
        after,
        offset,
        nextOffset: before.nextOffset ?? after.nextOffset,
    };
}
