// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * replace-diff-overview.js — structured post-replace diff model builder
 * and full-screen HTML renderer for the CEA editor topbar's
 * "View full replace diff" button.
 *
 * Verified here:
 *   - buildReplaceDiffModel: emits card + book diff structures matching
 *     the mirrored prev/next inputs
 *   - renderReplaceDiffOverview: produces sectioned HTML with per-field
 *     card diffs, per-entry book diff cards, and expected summary chips
 *   - Empty / no-op inputs render an "empty" placeholder card and stay
 *     hasChanges=false so the studio topbar button can suppress itself
 */

import { jest } from '@jest/globals';

// Under test — pure ESM module, no ST context deps
const { buildReplaceDiffModel, renderReplaceDiffOverview } = await import(
    '../../public/scripts/extensions/character-editor-assistant/replace-diff-overview.js'
);

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

function mkEntry(uid, { comment = '', content = '', keys = [], constant = false } = {}) {
    return { uid, comment, content, keys, secondary_keys: [], constant, selective: true, enabled: true, position: 0, insertion_order: 100 };
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

describe('renderReplaceDiffOverview', () => {
    const noOpRenderLineDiff = (before, after, label) =>
        `<!-- line diff placeholder: label=${label}, before=${String(before ?? '').slice(0, 20)}, after=${String(after ?? '').slice(0, 20)} -->`;

    test('renders "empty" placeholder when hasChanges is false', () => {
        const html = renderReplaceDiffOverview(
            { hasChanges: false, card: { previousName: '', nextName: '', fields: [] }, book: { previousName: '', nextName: '', renamed: false, added: [], removed: [], changed: [], unchangedCount: 0 } },
            { renderLineDiffHtml: noOpRenderLineDiff },
        );
        expect(html).toContain('cea_replace_diff_overview');
        expect(html).toContain('cea_replace_diff_empty');
    });

    test('emits sectioned HTML with card fields + book summary + entry groups', () => {
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
        const html = renderReplaceDiffOverview(model, { renderLineDiffHtml: noOpRenderLineDiff });

        expect(html).toContain('cea_replace_diff_section');
        // card section — description diff card should be present
        expect(html).toContain('cea_replace_diff_card_field');
        expect(html).toMatch(/description/);
        // book summary chips
        expect(html).toContain('cea_replace_diff_stat_add');
        expect(html).toContain('+1'); // 1 added
        expect(html).toContain('cea_replace_diff_stat_del');
        expect(html).toContain('−1'); // 1 removed
        expect(html).toContain('cea_replace_diff_stat_mod');
        expect(html).toContain('~1'); // 1 changed
        // entry groups
        expect(html).toContain('cea_replace_diff_group_add');
        expect(html).toContain('cea_replace_diff_group_del');
        expect(html).toContain('cea_replace_diff_group_mod');
        // line-diff placeholder wired for description AND changed entry.2.content
        expect(html).toContain('label=card.description');
        expect(html).toContain('label=entry.2.content');
    });

    test('falls back to simple prev/next blocks when no renderLineDiffHtml provided', () => {
        const prev = mkCard({ name: 'Sable', description: 'old', world: 'b' });
        const next = mkCard({ name: 'Sable', description: 'new', world: 'b' });
        const model = buildReplaceDiffModel({
            previousCharacter: prev,
            nextCharacter: next,
            previousLorebookSnapshot: { bookName: 'b', entries: {} },
            nextLorebookData: { entries: {} },
        });
        const html = renderReplaceDiffOverview(model, {});
        // fallback path renders cea_replace_diff_prev_next grid
        expect(html).toContain('cea_replace_diff_prev_next');
        // shows both prev and current values inline
        expect(html).toContain('>old<');
        expect(html).toContain('>new<');
    });

    test('accepts i18n hooks and passes messages through', () => {
        const model = { hasChanges: false, card: { previousName: '', nextName: '', fields: [] }, book: { previousName: '', nextName: '', renamed: false, added: [], removed: [], changed: [], unchangedCount: 0 } };
        const t = (s) => `[TR:${s}]`;
        const html = renderReplaceDiffOverview(model, { i18n: t });
        expect(html).toContain('[TR:No structural changes detected');
    });
});
