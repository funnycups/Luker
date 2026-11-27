/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { buildReplaceDiffModel } from '../../public/scripts/workbench/model/card-replacement.js';
import { renderReplacementOverview } from '../../public/scripts/workbench/targets/card-preview.js';

function mkCard({ name, description, world = '', bookEntries = null }) {
    const character = {
        name,
        data: {
            name,
            description: description || '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creator_notes: '',
            tags: [],
            extensions: world ? { world } : {},
        },
    };
    if (bookEntries) {
        character.data.character_book = { entries: bookEntries };
    }
    return character;
}

// World-info entry shape — what the pre-replace disk snapshot and
// convertCharacterBook / loadWorldInfo produce.
function mkEntry(uid, { comment = '', content = '', key = [], constant = false, disable = false, order = 100 } = {}) {
    return { uid, comment, content, key, keysecondary: [], constant, selective: true, disable, position: 0, order };
}

describe('buildReplaceDiffModel', () => {
    test('emits card + book diff for a full prev/next payload', () => {
        const prev = mkCard({ name: 'Sable', description: 'watchtower captain', world: 'watchtower-lore' });
        const next = mkCard({ name: 'Sable', description: 'watchtower captain, promoted', world: 'watchtower-lore' });
        const model = buildReplaceDiffModel({
            previousCharacter: prev,
            nextCharacter: next,
            previousLorebookSnapshot: {
                bookName: 'watchtower-lore',
                entries: {
                    '1': mkEntry('1', { comment: 'brief', content: 'old brief content' }),
                    '2': mkEntry('2', { comment: 'schedule', content: 'shifts A/B' }),
                },
            },
            nextLorebookData: {
                entries: {
                    '1': mkEntry('1', { comment: 'brief', content: 'new brief content' }),
                    '3': mkEntry('3', { comment: 'storm-codes', content: 'red / amber / green' }),
                },
            },
        });

        expect(model.hasChanges).toBe(true);
        // description changed
        const descField = model.card.fields.find(f => f.key === 'description');
        expect(descField).toBeTruthy();
        expect(descField.previous).toContain('watchtower captain');
        expect(descField.next).toContain('promoted');
        // book stats
        expect(model.book.previousName).toBe('watchtower-lore');
        expect(model.book.nextName).toBe('watchtower-lore');
        expect(model.book.renamed).toBe(false);
        expect(model.book.added.map(e => e.uid)).toEqual(['3']);
        expect(model.book.removed.map(e => e.uid)).toEqual(['2']);
        expect(model.book.changed.map(e => e.uid)).toEqual(['1']);
        expect(model.book.unchangedCount).toBe(0);
        // per-entry changed fields
        expect(model.book.changed[0].changedFields).toContain('content');
    });

    test('flags renamed book (prevName !== nextName)', () => {
        const prev = mkCard({ name: 'X', world: 'old-book' });
        const next = mkCard({ name: 'X', world: 'new-book' });
        const model = buildReplaceDiffModel({
            previousCharacter: prev,
            nextCharacter: next,
            previousLorebookSnapshot: { bookName: 'old-book', entries: {} },
            nextLorebookData: { entries: {} },
        });
        expect(model.book.renamed).toBe(true);
        expect(model.book.previousName).toBe('old-book');
        expect(model.book.nextName).toBe('new-book');
        expect(model.hasChanges).toBe(true);
    });

    test('hasChanges=false when everything is identical', () => {
        const same = mkCard({ name: 'X', description: 'same', world: 'b' });
        const entries = { '1': mkEntry('1', { comment: 'c', content: 'v' }) };
        const model = buildReplaceDiffModel({
            previousCharacter: same,
            nextCharacter: same,
            previousLorebookSnapshot: { bookName: 'b', entries },
            nextLorebookData: { entries },
        });
        expect(model.hasChanges).toBe(false);
        expect(model.card.fields).toEqual([]);
        expect(model.book.added).toEqual([]);
        expect(model.book.removed).toEqual([]);
        expect(model.book.changed).toEqual([]);
        expect(model.book.unchangedCount).toBe(1);
    });

    test('handles missing prev snapshot / next book gracefully', () => {
        const next = mkCard({ name: 'X', world: '' });
        const model = buildReplaceDiffModel({
            previousCharacter: null,
            nextCharacter: next,
        });
        // No prev = card fields are all "next" values; empty prev fields → all diff
        // (name / description default '' vs 'X' + '') — depending on impl.
        // The important contract: doesn't throw, book section empty.
        expect(model.book.added).toEqual([]);
        expect(model.book.removed).toEqual([]);
    });
});

describe('renderReplacementOverview', () => {
    test('renders "empty" placeholder when hasChanges is false', () => {
        const node = renderReplacementOverview(
            { hasChanges: false, card: { previousName: '', nextName: '', fields: [] }, book: { previousName: '', nextName: '', renamed: false, added: [], removed: [], changed: [], unchangedCount: 0 } },
        );
        expect(node.querySelector('.wb-note')?.textContent?.trim().length).toBeGreaterThan(0);
        expect(node.querySelectorAll(':scope > section')).toHaveLength(0);
    });

    test('renders card fields, book statistics and entry groups', () => {
        const prev = mkCard({ name: 'Sable', description: 'old', world: 'b' });
        const next = mkCard({ name: 'Sable', description: 'new', world: 'b' });
        const model = buildReplaceDiffModel({
            previousCharacter: prev,
            nextCharacter: next,
            previousLorebookSnapshot: {
                bookName: 'b',
                entries: {
                    '1': mkEntry('1', { comment: 'gone', content: 'gone body' }),
                    '2': mkEntry('2', { comment: 'shared', content: 'v1' }),
                },
            },
            nextLorebookData: {
                entries: {
                    '2': mkEntry('2', { comment: 'shared', content: 'v2' }),
                    '3': mkEntry('3', { comment: 'new-one', content: 'new body' }),
                },
            },
        });
        const node = renderReplacementOverview(model);
        expect(node.querySelectorAll(':scope > section')).toHaveLength(2);
        expect(node.textContent).toContain('card.description');
        expect(node.textContent).toContain('entry.2.content');
        const statTexts = [...node.querySelectorAll('.wb-replace-stats > span')].map(el => el.textContent.trim());
        expect(statTexts).toHaveLength(4);
        expect(statTexts[0]).toMatch(/^\+1\b/);
        expect(statTexts[1]).toMatch(/^−1\b/);
        expect(statTexts[2]).toMatch(/^~1\b/);
        expect(statTexts[3]).toMatch(/^=0\b/);
        expect(node.querySelector('[data-change-kind="add"]').textContent).toContain('new body');
        expect(node.querySelector('[data-change-kind="del"]').textContent).toContain('gone body');
        const changed = node.querySelector('[data-change-kind="mod"]');
        expect(changed.querySelector('.luker_lib_diff_text.old').textContent).toBe('v1');
        expect(changed.querySelector('.luker_lib_diff_text.new').textContent).toBe('v2');
    });

    test('renders complete previous and current field values', () => {
        const prev = mkCard({ name: 'Sable', description: 'old', world: 'b' });
        const next = mkCard({ name: 'Sable', description: 'new', world: 'b' });
        const model = buildReplaceDiffModel({
            previousCharacter: prev,
            nextCharacter: next,
            previousLorebookSnapshot: { bookName: 'b', entries: {} },
            nextLorebookData: { entries: {} },
        });
        const node = renderReplacementOverview(model);
        expect(node.querySelector('.luker_lib_diff_text.old').textContent).toBe('old');
        expect(node.querySelector('.luker_lib_diff_text.new').textContent).toBe('new');
    });

    test('renders markup-shaped card values as text', () => {
        const payload = '<img src="invalid" onerror="throw new Error()">';
        const model = buildReplaceDiffModel({
            previousCharacter: mkCard({ name: 'Sable', description: 'old' }),
            nextCharacter: mkCard({ name: 'Sable', description: payload }),
        });
        const node = renderReplacementOverview(model);
        expect(node.querySelector('img')).toBeNull();
        expect(node.querySelector('.luker_lib_diff_text.new').textContent).toBe(payload);
    });
});

describe('world-info entry fields', () => {
    function diffOf(prevEntry, nextEntry) {
        const card = mkCard({ name: 'Ash', world: 'bryn-headland' });
        return buildReplaceDiffModel({
            previousCharacter: card,
            nextCharacter: card,
            previousLorebookSnapshot: { bookName: 'bryn-headland', entries: { '0': prevEntry } },
            nextLorebookData: { entries: { '0': nextEntry } },
        });
    }

    test('a key-only change is reported', () => {
        const model = diffOf(
            mkEntry('0', { comment: 'reef', key: ['reef'] }),
            mkEntry('0', { comment: 'reef', key: ['reef', 'breakers'] }),
        );
        expect(model.book.changed.map(c => c.changedFields)).toEqual([['key']]);
    });

    test('order and enable changes are reported', () => {
        const model = diffOf(
            mkEntry('0', { comment: 'reef', order: 100 }),
            mkEntry('0', { comment: 'reef', order: 250, disable: true }),
        );
        expect(model.book.changed[0].changedFields).toEqual(['disable', 'order']);
    });

    test('an uncommented entry is titled by its keys', () => {
        const model = diffOf(
            mkEntry('0', { key: ['lantern'], content: 'The lantern burns whale oil.' }),
            mkEntry('0', { key: ['lantern', 'eastern light'], content: 'The eastern light burns whale oil on a sixteen-hour cycle.' }),
        );
        const node = renderReplacementOverview(model);
        expect(node.querySelector('[data-change-kind="mod"] h4').textContent).toBe('0 · lantern, eastern light');
    });
});
