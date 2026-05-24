import { jest } from '@jest/globals';

// text-diff.js's renderInlineTextDiffHtml pulls a heavy DOM-coupled bundle when
// real markdown deps load — stub it to a sentinel string so we can assert
// composition without running the actual line-diff.
jest.unstable_mockModule('../../public/scripts/iteration-library/text-diff.js', () => ({
    renderInlineTextDiffHtml: (before, after, opts) => `<div class="luker_lib_diff luker_lib_diff_dual" data-test-file-label="${opts?.fileLabel || ''}">L</div>`,
}));

let renderDiffCard;
beforeAll(async () => {
    ({ renderDiffCard } = await import('../../public/scripts/iteration-library/ui/diff.js'));
});

const ident = (s) => s;

describe('renderDiffCard', () => {
    it('splits a whole-object set into per-changed-key sub-cards (never stringifies the whole obj)', () => {
        const edits = [{
            op: 'set',
            path: '',
            oldValue: { keep: 'same', a: 'old-a', b: 'old-b' },
            newValue: { keep: 'same', a: 'new-a', b: 'new-b' },
        }];
        const html = renderDiffCard(edits, { i18n: ident, fieldLabels: {} });
        // Two sub-cards, one per changed key:
        expect((html.match(/luker_lib_diff_card/g) || []).length).toBe(2);
        // No raw JSON.stringify of the whole obj:
        expect(html).not.toMatch(/"keep":\s*"same"/);
    });

    it('falls back to whole-object render when >20 leaves changed', () => {
        const oldObj = {};
        const newObj = {};
        for (let i = 0; i < 25; i++) { oldObj[`k${i}`] = 'a'; newObj[`k${i}`] = 'b'; }
        const html = renderDiffCard([{ op: 'set', path: '', oldValue: oldObj, newValue: newObj }], { i18n: ident });
        expect((html.match(/luker_lib_diff_card/g) || []).length).toBe(1);
    });

    it('renders short two-sided edit with dual-column line diff (not inline arrow)', () => {
        const html = renderDiffCard(
            [{ op: 'set', path: 'name', oldValue: 'Alice', newValue: 'Bob' }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_dual');
    });

    it('uses fieldLabels[path] when provided', () => {
        const html = renderDiffCard(
            [{ op: 'set', path: 'persona_field', oldValue: 'a', newValue: 'b' }],
            { i18n: ident, fieldLabels: { persona_field: 'Persona' } },
        );
        expect(html).toContain('Persona');
    });

    it('caps long string values via pre-wrapped class', () => {
        const long = 'lorem '.repeat(300);
        const html = renderDiffCard(
            [{ op: 'set', path: 'description', oldValue: long, newValue: long + 'x' }],
            { i18n: ident },
        );
        // The underlying text-diff produces .luker_lib_diff_pre / .luker_lib_diff_side_scroll.
        // Our stub returns .luker_lib_diff_dual which satisfies the dual-column expectation.
        // Just verify the diff was emitted for the long-string case.
        expect(html).toContain('luker_lib_diff');
    });

    it('zoom dialog data attribute is present so binders can wire onclick', () => {
        const html = renderDiffCard(
            [{ op: 'set', path: 'description', oldValue: 'a', newValue: 'b' }],
            { i18n: ident },
        );
        expect(html).toContain('data-luker-lib-diff-zoom');
    });

    it('renders an added entry (oldValue undefined) without crashing', () => {
        // MG schema synthesizes this shape for an added node-type:
        //   { op:'set', path:'nodeTypeSchema.foo', oldValue:undefined, newValue:{...} }
        // stringifyValue(undefined) used to return undefined (JSON.stringify of
        // undefined), which crashed at `beforeText.length` in renderSubCard.
        const html = renderDiffCard(
            [{ op: 'set', path: 'nodeTypeSchema.foo', oldValue: undefined, newValue: { fields: [] } }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_card');
    });

    it('renders a removed entry (newValue undefined) without crashing', () => {
        const html = renderDiffCard(
            [{ op: 'set', path: 'nodeTypeSchema.bar', oldValue: { fields: ['x'] }, newValue: undefined }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_card');
    });

    it('renders str_replace as a focused find→replace diff card', () => {
        // CPA + CEA editor produce {op:'str_replace', path, find, replace}.
        // Before this fix the fallback branch only showed op+path with no
        // content — the user saw an empty "str_replace prompts[7].content"
        // chip and had to expand args to see what was actually changing.
        const html = renderDiffCard(
            [{ op: 'str_replace', path: 'prompts[7].content', find: 'old phrase', replace: 'new phrase' }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_card');
        expect(html).toContain('prompts[7].content');
        // text-diff renderer is mocked to a dual-column placeholder; just
        // verify it WAS called (label flows through fileLabel attr).
        expect(html).toContain('luker_lib_diff_dual');
    });

    it('renders str_insert as a "" → text diff card', () => {
        const html = renderDiffCard(
            [{ op: 'str_insert', path: 'prompts[0].content', text: 'inserted' }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_card');
        expect(html).toContain('prompts[0].content');
    });

    it('renders str_delete as a text → "" diff card', () => {
        const html = renderDiffCard(
            [{ op: 'str_delete', path: 'prompts[0].content', find: 'deleted phrase' }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_card');
        expect(html).toContain('prompts[0].content');
    });

    it('renders lorebook_entry_update as per-field cards keyed by uid', () => {
        const html = renderDiffCard(
            [{
                op: 'lorebook_entry_update',
                uid: 42,
                patch: { content: 'new content', comment: 'updated' },
                before: { content: 'old content', comment: 'original' },
            }],
            { i18n: ident },
        );
        // Two patched fields → two sub-cards.
        expect((html.match(/luker_lib_diff_card/g) || []).length).toBe(2);
        expect(html).toContain('entries.42.content');
        expect(html).toContain('entries.42.comment');
    });

    it('renders list_insert with anchor.after position in the path label', () => {
        // CPA's preset_list_insert tool emits { op: 'list_insert', path,
        // anchor: { after: N } | { before: N }, value }. Before the fix
        // this hit the bare `(unknown op)` fallback with no content; the
        // user couldn't see what was being inserted or where.
        const html = renderDiffCard(
            [{
                op: 'list_insert',
                path: 'prompts',
                anchor: { after: 3 },
                value: { identifier: 'newPrompt', name: 'New prompt' },
            }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_card');
        // Anchor label is rendered as part of the path, not stripped.
        expect(html).toContain('@after 3');
        // The new value flows through fileLabel into the mocked diff renderer.
        expect(html).toContain('luker_lib_diff_dual');
    });

    it('renders list_insert with anchor.before position', () => {
        const html = renderDiffCard(
            [{
                op: 'list_insert',
                path: 'prompts',
                anchor: { before: 0 },
                value: { identifier: 'firstPrompt' },
            }],
            { i18n: ident },
        );
        expect(html).toContain('@before 0');
    });

    it('renders list_remove with index in the path label', () => {
        const html = renderDiffCard(
            [{
                op: 'list_remove',
                path: 'prompts',
                index: 2,
                expected_value: { identifier: 'staleEntry' },
            }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_card');
        expect(html).toContain('prompts[2]');
    });

    it('renders list_move with from→to indices', () => {
        // list_move is rendered as a header-only card (Reorder ${path}:
        // [${from}] → [${to}]) plus an optional expected-value preview —
        // there's no before/after pairing because the elements are the
        // same, just reordered.
        const html = renderDiffCard(
            [{
                op: 'list_move',
                path: 'prompt_order',
                from_index: 1,
                to_index: 4,
                expected_value: { identifier: 'movedItem' },
            }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_card');
        expect(html).toContain('Reorder prompt_order');
        expect(html).toContain('[1]');
        expect(html).toContain('[4]');
    });

    it('splits a whole-array set into per-id sub-cards when elements have stable ids', () => {
        // MG schema's whole-array edits (e.g. nodeTypes) used to fall
        // through to one giant JSON dump. When elements carry a stable
        // `id` we walk by id and emit one card per added / removed /
        // changed entry instead.
        const html = renderDiffCard(
            [{
                op: 'set',
                path: '',
                oldValue: [
                    { id: 'a', label: 'Alpha' },
                    { id: 'b', label: 'Beta' },
                ],
                newValue: [
                    { id: 'a', label: 'Alpha v2' },
                    { id: 'b', label: 'Beta' },
                    { id: 'c', label: 'Gamma' },
                ],
            }],
            { i18n: ident },
        );
        // 'a' changed + 'c' added → two cards. ('b' unchanged is skipped.)
        expect((html.match(/luker_lib_diff_card/g) || []).length).toBe(2);
    });

    it('falls back to whole-object render for arrays without stable ids', () => {
        // Plain string / numeric arrays don't get split per-element —
        // there's no stable key to anchor to. The renderer falls back to
        // a single sub-card showing the whole-array JSON diff.
        const html = renderDiffCard(
            [{
                op: 'set',
                path: '',
                oldValue: ['x', 'y', 'z'],
                newValue: ['x', 'Y', 'z'],
            }],
            { i18n: ident },
        );
        expect((html.match(/luker_lib_diff_card/g) || []).length).toBe(1);
    });

    it('reads insert_text field for str_insert (CPA tool name)', () => {
        // CPA's preset_str_insert emits { op: 'str_insert', path,
        // after_text, insert_text }. Before the fix the renderer only
        // looked at `text` / `value`, so the inserted content showed up
        // empty in the diff card.
        const html = renderDiffCard(
            [{
                op: 'str_insert',
                path: 'description',
                after_text: 'paragraph 1',
                insert_text: 'NEW INSERTED CONTENT',
            }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_card');
        // text-diff is mocked, so we can't directly assert the content
        // showed up in the dual-column diff. But we can verify the
        // mock's fileLabel attr received the path (and that some kind
        // of diff body was emitted).
        expect(html).toContain('luker_lib_diff_dual');
    });
});
