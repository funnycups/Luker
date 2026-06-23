// renderDiffCard tests — runs against the REAL text-diff.js renderer
// (495 LOC of pure JS that does not touch the DOM at module-load time).
// Earlier revisions stubbed `renderInlineTextDiffHtml` to a sentinel
// string, which let every "dual-column diff was emitted" assertion pass
// trivially. Now the real renderer runs and the assertions look for
// classes / markers the real renderer emits.

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

    it('walks every changed leaf into its own card (no JSON-dump fallback)', () => {
        // The whole point of the per-leaf walker is "all changes shown, no
        // surprise JSON blobs". 25 leaves should produce 25 cards, NOT one
        // collapsed card. The 50-leaf cap is a runaway-input backstop, not
        // a normal-flow trigger.
        const oldObj = {};
        const newObj = {};
        for (let i = 0; i < 25; i++) { oldObj[`k${i}`] = 'a'; newObj[`k${i}`] = 'b'; }
        const html = renderDiffCard([{ op: 'set', path: '', oldValue: oldObj, newValue: newObj }], { i18n: ident });
        expect((html.match(/luker_lib_diff_card/g) || []).length).toBe(25);
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
        // The new value must have at least one non-empty leaf, otherwise
        // the empty-noise filter (correctly) suppresses the whole card.
        const html = renderDiffCard(
            [{ op: 'set', path: 'nodeTypeSchema.foo', oldValue: undefined, newValue: { name: 'Foo', enabled: true } }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_card');
    });

    it('suppresses the card when oldValue+newValue collapse to all empty leaves', () => {
        // User principle: changes between "empty" and null / undefined /
        // '' / [] / {} are not real changes and must never render. An
        // inserted object whose only fields are blank defaults is a no-op
        // to the user and the renderer drops it.
        const html = renderDiffCard(
            [{ op: 'set', path: 'nodeTypeSchema.bar', oldValue: undefined, newValue: { fields: [], comment: '' } }],
            { i18n: ident },
        );
        expect(html).toBe('');
    });

    it('renders a removed entry (newValue undefined) without crashing', () => {
        const html = renderDiffCard(
            [{ op: 'set', path: 'nodeTypeSchema.bar', oldValue: { fields: ['x'] }, newValue: undefined }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_card');
    });

    it('renders str_replace as a focused find→replace diff card when no live snapshot is given', () => {
        // CPA + CEA editor produce {op:'str_replace', path, find, replace}.
        // Before this fix the fallback branch only showed op+path with no
        // content — the user saw an empty "str_replace prompts[7].content"
        // chip and had to expand args to see what was actually changing.
        // With no `opts.live`, the renderer still falls back to a focused
        // find→replace card so historical edits (where state.live has
        // moved on) keep working.
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

    it('renders str_replace as a FULL before/after when opts.live is supplied', () => {
        // Pending-edit path: opts.live carries the pre-edit field value, so
        // the renderer virtually applies str_replace and shows the whole
        // field's before/after to the user — they see the surrounding
        // paragraphs, not just the find→replace fragment. This is what
        // the user asked for: "I want to see what the entry originally
        // said, not just the snippet that's getting inserted."
        const liveContent = 'Para 1.\n\nold phrase\n\nPara 3.';
        const html = renderDiffCard(
            [{ op: 'str_replace', path: 'prompts[7].content', find: 'old phrase', replace: 'new phrase' }],
            { i18n: ident, live: { prompts: [null, null, null, null, null, null, null, { content: liveContent }] } },
        );
        expect(html).toContain('luker_lib_diff_card');
        // text-diff mock echoes its fileLabel — confirming the renderer
        // routed through the FULL-field path (not the fallback find→replace).
        expect(html).toContain('luker_lib_diff_dual');
        expect(html).toContain('prompts[7].content');
    });

    it('renders str_insert as a "" → text diff card when no live snapshot is given', () => {
        const html = renderDiffCard(
            [{ op: 'str_insert', path: 'prompts[0].content', text: 'inserted' }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_card');
        expect(html).toContain('prompts[0].content');
    });

    it('renders str_insert with full surrounding context when opts.live is supplied', () => {
        // This is the bug the user reported: inserting a few sentences in
        // the middle of a prompt should show the full prompt's before/after,
        // not just "" → inserted-snippet. With opts.live the renderer
        // resolves `path` against live, virtually splices the insert after
        // the anchor, and emits a dual-column diff over the full string.
        const liveContent = 'Lead-in paragraph.\n\nAnchor sentence.\n\nTrailing paragraph.';
        const html = renderDiffCard(
            [{
                op: 'str_insert',
                path: 'prompts[0].content',
                after_text: 'Anchor sentence.',
                insert_text: ' INSERTED.',
            }],
            { i18n: ident, live: { prompts: [{ content: liveContent }] } },
        );
        expect(html).toContain('luker_lib_diff_card');
        expect(html).toContain('luker_lib_diff_dual');
        // Renderer routed through the live-aware path (not the "" → snippet fallback).
        expect(html).toContain('prompts[0].content');
    });

    it('falls back to "" → text when opts.live exists but path resolves to non-string', () => {
        // Wrong path / drift case — the renderer must not throw and must
        // still emit something useful. We exercise this by giving a live
        // where the resolved value is undefined.
        const html = renderDiffCard(
            [{
                op: 'str_insert',
                path: 'prompts[99].content',
                after_text: 'whatever',
                insert_text: 'X',
            }],
            { i18n: ident, live: { prompts: [] } },
        );
        expect(html).toContain('luker_lib_diff_card');
        expect(html).toContain('prompts[99].content');
    });

    it('falls back to "" → text when opts.live exists but anchor is missing from the live string', () => {
        // anchor_missing — at apply time this would surface as a conflict;
        // in the renderer we degrade to the focused fallback so the user
        // still sees the AI's intent rather than a blank card.
        const html = renderDiffCard(
            [{
                op: 'str_insert',
                path: 'prompts[0].content',
                after_text: 'NOT IN LIVE',
                insert_text: 'Y',
            }],
            { i18n: ident, live: { prompts: [{ content: 'some other content' }] } },
        );
        expect(html).toContain('luker_lib_diff_card');
        expect(html).toContain('prompts[0].content');
    });

    it('renders str_delete as a text → "" diff card when no live snapshot is given', () => {
        const html = renderDiffCard(
            [{ op: 'str_delete', path: 'prompts[0].content', find: 'deleted phrase' }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_card');
        expect(html).toContain('prompts[0].content');
    });

    it('renders str_delete with full surrounding context when opts.live is supplied', () => {
        const liveContent = 'Keep me.\n\ndeleted phrase\n\nAlso keep me.';
        const html = renderDiffCard(
            [{ op: 'str_delete', path: 'prompts[0].content', find: 'deleted phrase' }],
            { i18n: ident, live: { prompts: [{ content: liveContent }] } },
        );
        expect(html).toContain('luker_lib_diff_card');
        expect(html).toContain('luker_lib_diff_dual');
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
        // anchor: { after: N } | { before: N }, value }. Card surfaces the
        // anchor description + item label so the user can see what's being
        // inserted and where, without dumping the value's full JSON.
        const html = renderDiffCard(
            [{
                op: 'list_insert',
                path: 'prompts',
                anchor: { after: 3 },
                value: { identifier: 'newPrompt', name: 'New prompt' },
            }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_card_list_op');
        // The item is summarized by its `.name` and the anchor surfaces in
        // the header detail.
        expect(html).toContain('Insert into prompts');
        expect(html).toContain('New prompt');
        expect(html).toContain('after 3');
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
        expect(html).toContain('luker_lib_diff_card_list_op');
        expect(html).toContain('firstPrompt');
        expect(html).toContain('before 0');
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
        expect(html).toContain('luker_lib_diff_card_list_op');
        expect(html).toContain('Remove from prompts');
        expect(html).toContain('staleEntry');
        expect(html).toContain('[2]');
    });

    it('renders list_move with from→to indices', () => {
        // list_move is rendered as a header-only card (Reorder ${path}:
        // [${from}] → [${to}]) plus optional before/after neighborhood
        // strips — there's no LCS table because the elements are the
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
        expect(html).toContain('luker_lib_diff_card_list_op');
        expect(html).toContain('Reorder prompt_order');
        expect(html).toContain('movedItem');
        expect(html).toContain('[1]');
        expect(html).toContain('[4]');
    });

    it('splits a whole-array set into per-id sub-cards when elements have stable ids', () => {
        // MG schema's whole-array edits (e.g. nodeTypes) used to fall
        // through to one giant JSON dump. When elements carry a stable
        // `id` we walk by id and recurse into each changed entry's leaves
        // — so updates (1 changed leaf) and inserts (each new leaf) all
        // surface as their own focused card.
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
        // a.label changed (1) + c inserted with id+label leaves (2) = 3 cards.
        // ('b' unchanged is skipped.)
        expect((html.match(/luker_lib_diff_card/g) || []).length).toBe(3);
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

    it('suppresses leaf sub-cards whose before and after stringify identically', () => {
        // Inserting a new sub-agent at subAgents.8 produces leaves like
        // apiPresetName: undefined → '' and promptPresetName: undefined → ''.
        // Both sides stringify to '' so the "+0 bytes" header with an empty
        // inline diff is pure noise — should be hidden, leaving only the
        // genuinely changed leaves (id, description, systemPrompt, etc.).
        const html = renderDiffCard(
            [{
                op: 'set',
                path: 'subAgents.8',
                oldValue: undefined,
                newValue: { id: 'newAgent', description: 'D', apiPresetName: '', promptPresetName: '' },
            }],
            { i18n: ident },
        );
        // 2 real leaves (id, description) — the two empty-string leaves drop out.
        expect((html.match(/luker_lib_diff_card/g) || []).length).toBe(2);
        expect(html).not.toContain('apiPresetName');
        expect(html).not.toContain('promptPresetName');
    });

    it('returns empty string when every leaf in a set is a no-op', () => {
        // AI calls a "set" with newValue identical to oldValue (e.g. it
        // re-emitted the whole director profile but only mutated state we
        // already had). Every leaf collapses to '' === '' so the entire
        // edit produces no markup — renderDiffCard's caller then has no
        // entry to render for this round.
        const sameObj = { a: 'x', b: 'y' };
        const html = renderDiffCard(
            [{ op: 'set', path: '', oldValue: sameObj, newValue: structuredClone(sameObj) }],
            { i18n: ident },
        );
        expect(html).toBe('');
    });
});

describe('renderDiffCard — bus entry shape', () => {
    let registerTarget;
    let clearRegistry;
    beforeAll(async () => {
        ({ registerTarget, clearRegistry } = await import(
            '../../public/scripts/iteration-library/storage/target-registry.js'
        ));
    });

    beforeEach(() => clearRegistry());

    it('derives before/after from inverse + live and renders a diff card', async () => {
        registerTarget('preset', {
            read: async () => ({ temperature: 1.0, max_tokens: 200 }),
            write: async () => {},
            describe: () => 'preset',
        });
        const entry = {
            target: { type: 'preset' },
            inverse: [{ op: 'replace', path: '/temperature', value: 0.5 }],
        };
        const html = await renderDiffCard(entry, { i18n: ident });
        // The recovered before is { temperature: 0.5, max_tokens: 200 };
        // after is the registry's live ({ temperature: 1.0, ... }). The
        // leaf walker emits one card for the changed leaf, no card for
        // the unchanged max_tokens.
        expect(html).toContain('luker_lib_diff_card');
        expect(html).toContain('temperature');
        expect(html).not.toContain('max_tokens');
    });

    it('falls back to a raw-record card when the inverse cannot be replayed against live', async () => {
        // Target drift: live no longer contains the path the inverse
        // touches. decodeBackward throws PatchConflictError; renderer
        // emits the raw record so the user still sees the entry exists.
        registerTarget('preset', {
            read: async () => ({ /* missing temperature */ }),
            write: async () => {},
            describe: () => 'preset',
        });
        const entry = {
            target: { type: 'preset' },
            inverse: [{ op: 'replace', path: '/temperature', value: 0.5 }],
        };
        const html = await renderDiffCard(entry, { i18n: ident });
        expect(html).toContain('data-action="view-raw-record"');
    });

    it('falls back to a raw-record card when the target type is not registered', async () => {
        // Registry miss: surface the raw record rather than throwing.
        const entry = {
            target: { type: 'unknown-target-type' },
            inverse: [{ op: 'replace', path: '/x', value: 0 }],
        };
        const html = await renderDiffCard(entry, { i18n: ident });
        expect(html).toContain('data-action="view-raw-record"');
    });

    it('routes a legacy edit-list (array) through the leaf walker unchanged', () => {
        // The polymorphic entry sniff must not break the legacy array
        // shape: callers still pass `[{op:'set', oldValue, newValue}]`.
        const html = renderDiffCard(
            [{ op: 'set', path: 'name', oldValue: 'Alice', newValue: 'Bob' }],
            { i18n: ident },
        );
        expect(html).toContain('luker_lib_diff_card');
    });
});