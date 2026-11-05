/**
 * World book conflict grouping.
 *
 * Entries are stored as an array or as an object keyed by a number, and
 * the array order is not the display order. Normalize by displayIndex
 * before diffing so a reorder is a real move, not a wall of renumbered
 * index fields.
 */

import { collectChanges } from './changes.js';
import { worldBookFieldLabel } from './labels.js';
import { renderChange } from './render-change.js';

const HIDDEN_FIELDS = new Set(['uid', 'id', 'displayIndex']);

function displayOrder(entry) {
    const value = Number(entry?.displayIndex);
    return Number.isFinite(value) ? value : Infinity;
}

/**
 * @param {object} document
 * @returns {{ entries: object[] }}
 */
export function normalizeWorldBook(document) {
    const entries = document?.entries;
    const list = Array.isArray(entries) ? entries.slice() : Object.values(entries ?? {});
    const ordered = list
        .map((entry, index) => ({ entry, index }))
        .sort((left, right) => displayOrder(left.entry) - displayOrder(right.entry) || left.index - right.index)
        .map(item => item.entry);
    return { ...(document ?? {}), entries: ordered };
}

function firstLine(value) {
    if (typeof value !== 'string') return '';
    return value.trim().split('\n')[0].trim();
}

function entryLabel(item) {
    const entry = item.after ?? item.before ?? {};
    const comment = typeof entry.comment === 'string' ? entry.comment.trim() : '';
    if (comment) return comment;
    const content = firstLine(entry.content);
    if (content) return content.length > 60 ? content.slice(0, 60) : content;
    return `#${entry.uid ?? item.key}`;
}

function entryChildren(item, builder) {
    return (item.children ?? [])
        .filter(child => !HIDDEN_FIELDS.has(String(child.key)))
        .map(child => renderChange(child, builder, {
            label: worldBookFieldLabel(child.key),
            labelFor: worldBookFieldLabel,
        }));
}

/**
 * @param {object} left
 * @param {object} right
 * @param {ReturnType<import('./tree.js').createBuilder>} builder
 * @param {{ sectionLabel?: string, idFields?: string[] }} [options]
 */
export function renderWorldBook(left, right, builder, { sectionLabel = 'Entries', idFields = ['uid'] } = {}) {
    const leftBook = normalizeWorldBook(left);
    const rightBook = normalizeWorldBook(right);
    const change = collectChanges(leftBook.entries, rightBook.entries, {
        path: 'entries',
        idFields,
    });
    if (!change) return [];

    const children = [];
    for (const item of change.children ?? []) {
        const fields = entryChildren(item, builder);
        if (fields.length === 0 && !item.move && item.status === 'changed') continue;
        children.push(builder.item({
            label: entryLabel(item),
            translateLabel: false,
            status: item.status,
            children: fields,
            move: item.move,
        }));
    }

    if (children.length === 0) return [];
    return [builder.section({ label: sectionLabel, translateLabel: true, children })];
}
