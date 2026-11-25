// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, put } from '../../lens-shared/util.js';
import { renderInlineTextDiffElement } from '../../iteration-library/text-diff.js';
import { cardUnits } from '../model/adapters.js';
import { diffUnits } from '../model/units.js';
import { i18n, i18nFormat } from '../i18n.js';
import { buildReplaceDiffModel, formatReplacementValue } from '../model/card-replacement.js';

function fieldDiff(label, previous, next) {
    return h('section', { class: 'wb-replace-field' },
        h('h4', { text: label }),
        renderInlineTextDiffElement(
            formatReplacementValue(previous),
            formatReplacementValue(next),
            { fileLabel: label, i18n },
        ));
}

function entryHeading(uid, entry) {
    return h('h4', { text: `${uid} · ${entry.comment || (entry.key || []).join(', ')}` });
}

function fullEntry({ uid, entry }) {
    return h('section', {}, entryHeading(uid, entry),
        Object.entries(entry).map(([field, value]) => h('div', {},
            h('b', { text: field }),
            h('pre', { text: formatReplacementValue(value) }))));
}

export function renderReplacementOverview(model) {
    const overview = h('div', { class: 'wb-replace-diff' });
    if (!model.hasChanges) {
        put(overview, h('p', { class: 'wb-note', text: i18n('No structural changes detected between the previous version and the new one.') }));
        return overview;
    }
    const { card, book } = model;
    const cardSection = h('section', {},
        h('h3', { text: i18nFormat('Character card: ${0} → ${1}', card.previousName, card.nextName) }),
        card.fields.map(field => fieldDiff(`card.${field.key}`, field.previous, field.next)));
    const bookSection = h('section', {},
        h('h3', { text: book.renamed
            ? i18nFormat('World book: ${0} → ${1}', book.previousName, book.nextName)
            : i18nFormat('World book: ${0}', book.nextName || book.previousName) }),
        h('div', { class: 'wb-replace-stats' },
            h('span', { text: `+${book.added.length} ${i18n('added')}` }),
            h('span', { text: `−${book.removed.length} ${i18n('removed')}` }),
            h('span', { text: `~${book.changed.length} ${i18n('changed')}` }),
            h('span', { text: `=${book.unchangedCount} ${i18n('unchanged')}` })));
    const groups = [
        ['Added entries (${0})', book.added, 'add', fullEntry],
        ['Removed entries (${0})', book.removed, 'del', fullEntry],
        ['Changed entries (${0})', book.changed, 'mod', ({ uid, previous, next, changedFields }) => (
            h('section', {}, entryHeading(uid, next),
                changedFields.map(field => fieldDiff(`entry.${uid}.${field}`, previous[field], next[field])))
        )],
    ];
    for (const [label, entries, kind, render] of groups) {
        if (!entries.length) continue;
        put(bookSection, h('details', { open: true, 'data-change-kind': kind },
            h('summary', { text: i18nFormat(label, String(entries.length)) }),
            entries.map(render)));
    }
    put(overview, cardSection, bookSection);
    return overview;
}

export function renderCardPreview({ base, ai, context }) {
    if (!ai) return null;
    const preview = h('div', { class: 'wb-card-preview' });
    const units = cardUnits(ai);
    const changed = new Set(diffUnits(cardUnits(base), units).map(change => change.key));
    const changedEntries = new Set();
    for (const key of changed) {
        const raw = units.get(key)?.raw;
        if (raw?.book) changedEntries.add(JSON.stringify([raw.book, String(raw.uid)]));
    }
    const changeTag = () => h('span', { class: 'wb-chg-tag', text: '~' });
    if (context) {
        put(preview, h('details', {},
            h('summary', { text: i18n('View full replace diff') }),
            renderReplacementOverview(buildReplaceDiffModel(context))));
    }
    for (const [key, unit] of units) {
        if (!key.startsWith('card:')) continue;
        put(preview, h('details', {
            class: `wb-card-preview-field${changed.has(key) ? ' is-change' : ''}`,
            'data-card-field': unit.raw.field,
        },
        h('summary', {}, h('span', { text: unit.label }), changed.has(key) ? changeTag() : null),
        h('pre', { text: unit.text })));
    }
    for (const [name, book] of Object.entries(ai?.lorebooks || {})) {
        put(preview, h('details', { 'data-worldbook': name },
            h('summary', { text: name }),
            Object.entries(book?.entries || {}).map(([uid, entry]) => {
                const entryChanged = changedEntries.has(JSON.stringify([name, String(uid)]));
                return h('section', {
                    class: `wb-card-preview-entry${entryChanged ? ' is-change' : ''}`,
                    'data-entry-uid': uid,
                },
                h('h4', {},
                    h('span', { text: `#${uid} · ${entry.comment || (entry.key || []).join(', ')}` }),
                    entryChanged ? changeTag() : null),
                h('pre', { text: entry.content }));
            })));
    }
    return preview;
}
