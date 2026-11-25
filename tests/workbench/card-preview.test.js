/**
 * @jest-environment jsdom
 */
import { describe, expect, test } from '@jest/globals';
import { createCardTarget } from '../../public/scripts/workbench/targets/card.js';

describe('character iteration preview', () => {
    test('renders complete character fields and bound book entries', () => {
        const content = `${'The keeper records the entire night watch. '.repeat(30)}Final ledger entry.`;
        const live = {
            character: { name: 'Keeper', description: 'A careful keeper of the eastern light.' },
            lorebooks: {
                tides: { entries: { 7: { comment: 'Night watch', key: ['lantern'], content } } },
            },
        };
        const target = createCardTarget();
        expect(target.renderPreview).toEqual(expect.any(Function));
        const node = target.renderPreview({ base: live, ai: live });
        expect(node.textContent).toContain(live.character.description);
        expect(node.textContent).toContain('tides');
        expect(node.textContent).toContain('Night watch');
        expect(node.textContent).toContain(content);
        expect(node.querySelector('[data-worldbook="tides"] pre').textContent).toBe(content);
    });

    test('shows both captured replacement versions independently of current draft changes', () => {
        const context = {
            previousCharacter: { data: { name: 'Previous', description: 'Previous description.' } },
            nextCharacter: { data: { name: 'Current', description: 'Imported description.', extensions: { world: 'new-book' } } },
            previousLorebookSnapshot: {
                bookName: 'old-book',
                entries: { 1: { content: 'The previous book entry.' } },
            },
            nextLorebookData: { entries: { 2: { content: 'The imported book entry.' } } },
        };
        const live = {
            character: { name: 'Current', description: 'Edited after import.' },
            lorebooks: { 'new-book': { entries: { 2: { content: 'Edited after import.' } } } },
        };
        const before = JSON.stringify({ live, context });
        const target = createCardTarget();
        expect(target.renderPreview).toEqual(expect.any(Function));
        const node = target.renderPreview({ base: live, ai: live, context });
        const overview = node.querySelector('.wb-replace-diff');
        expect(overview.textContent).toContain('Previous description.');
        expect(overview.textContent).toContain('Imported description.');
        expect(overview.textContent).toContain('old-book');
        expect(overview.textContent).toContain('new-book');
        expect(overview.textContent).toContain('The previous book entry.');
        expect(overview.textContent).toContain('The imported book entry.');
        expect(overview.textContent).not.toContain('Edited after import.');
        expect(JSON.stringify({ live, context })).toBe(before);
    });
});
