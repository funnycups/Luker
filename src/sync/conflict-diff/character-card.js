/**
 * Character card conflict grouping.
 *
 * A card is a profile, an embedded world book and an extension bag. The
 * image is compared by the caller; this module only turns the card JSON
 * into readable sections.
 */

import { collectChanges } from './changes.js';
import { characterFieldLabel, humanizeKey } from './labels.js';
import { renderChange } from './render-change.js';
import { renderWorldBook } from './worldbook.js';

/**
 * V2 cards wrap the character fields in `data`; V1 cards are flat.
 *
 * @param {unknown} document
 * @returns {object}
 */
export function cardPayload(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) return {};
    return document.data && typeof document.data === 'object' && !Array.isArray(document.data)
        ? document.data
        : document;
}

function valueNode(change, builder) {
    return builder.field({
        label: 'Value',
        translateLabel: true,
        status: change.status,
        before: change.before,
        after: change.after,
    });
}

function bookSection(bookChange, leftBook, rightBook, builder) {
    if (bookChange.type === 'field') {
        return builder.section({ label: 'Embedded world book', children: [valueNode(bookChange, builder)] });
    }
    const sections = renderWorldBook(leftBook ?? {}, rightBook ?? {}, builder, {
        sectionLabel: 'Embedded world book',
        idFields: ['id', 'uid'],
    });
    const section = sections[0] ?? builder.section({ label: 'Embedded world book', children: [] });
    const extra = (bookChange.children ?? [])
        .filter(child => child.key !== 'entries')
        .map(child => renderChange(child, builder, {
            label: characterFieldLabel(child.key),
            labelFor: characterFieldLabel,
        }));
    section.children.push(...extra);
    return section.children.length > 0 ? section : null;
}

function extensionsSection(change, builder) {
    if (change.type === 'field') {
        return builder.section({ label: 'Extensions', children: [valueNode(change, builder)] });
    }
    if (change.type === 'object') {
        const children = (change.children ?? []).map(child => renderChange(child, builder, {
            label: humanizeKey(child.key),
            labelFor: humanizeKey,
        }));
        return children.length > 0 ? builder.section({ label: 'Extensions', children }) : null;
    }
    return builder.section({
        label: 'Extensions',
        children: [renderChange(change, builder, { label: 'Extensions', labelFor: humanizeKey })],
    });
}

/**
 * @param {object} leftDocument
 * @param {object} rightDocument
 * @param {ReturnType<import('./tree.js').createBuilder>} builder
 */
export function renderCharacter(leftDocument, rightDocument, builder) {
    const left = cardPayload(leftDocument);
    const right = cardPayload(rightDocument);
    const change = collectChanges(left, right);
    if (!change) return [];

    const sections = [];
    const profile = (change.children ?? [])
        .filter(child => child.key !== 'character_book' && child.key !== 'extensions')
        .map(child => renderChange(child, builder, {
            label: characterFieldLabel(child.key),
            labelFor: characterFieldLabel,
        }));
    if (profile.length > 0) sections.push(builder.section({ label: 'Profile', children: profile }));

    const bookChange = (change.children ?? []).find(child => child.key === 'character_book');
    if (bookChange) {
        const section = bookSection(bookChange, left.character_book, right.character_book, builder);
        if (section) sections.push(section);
    }

    const extensionChange = (change.children ?? []).find(child => child.key === 'extensions');
    if (extensionChange) {
        const section = extensionsSection(extensionChange, builder);
        if (section) sections.push(section);
    }

    return sections;
}
