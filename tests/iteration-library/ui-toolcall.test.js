import { jest } from '@jest/globals';
import { renderToolCallChip } from '../../public/scripts/iteration-library/ui/toolcall.js';

const ident = (s, ...args) => args.reduce((acc, v, i) => acc.replace(new RegExp('\\$\\{' + i + '\\}', 'g'), v), s);

describe('renderToolCallChip', () => {
    it('renders edit-type with friendly label + summary one-liner', () => {
        const html = renderToolCallChip(
            { id: 'c1', name: 'cea_set_card_field', args: { field: 'description', value: 'new' } },
            {
                toolDisplay: {
                    cea_set_card_field: { icon: '✏️', label: 'Set card field', type: 'edit', summarize: (a) => a.field },
                },
                status: 'ok',
                i18n: ident,
            },
        );
        expect(html).toContain('✅');
        expect(html).toContain('✏️');
        expect(html).toContain('Set card field');
        expect(html).toContain('description');
        expect(html).toContain('luker_lib_toolcall');
        expect(html).toContain('luker_lib_toolcall_edit');
    });

    it('renders read-type with result block when opts.result is present', () => {
        const html = renderToolCallChip(
            { id: 'c2', name: 'preset_read_live_fields', args: { paths: ['prompts'] } },
            {
                toolDisplay: {
                    preset_read_live_fields: {
                        icon: '📖',
                        label: 'Read preset fields',
                        type: 'read',
                        summarize: (a, r) => r ? `${Object.keys(r || {}).length} values` : `${(a.paths || []).length} paths`,
                    },
                },
                result: { prompts: ['a', 'b'] },
                status: 'ok',
                i18n: ident,
            },
        );
        expect(html).toContain('luker_lib_toolcall_read');
        expect(html).toContain('Read preset fields');
        expect(html).toContain('1 values');
        expect(html).toContain('luker_lib_toolcall_result');
    });

    it('falls back to truncated key-value pairs when no summarize is supplied', () => {
        const html = renderToolCallChip(
            { id: 'c3', name: 'unknown_tool', args: { a: 'short', b: 'medium', c: 'long-value-here-keeps-going' } },
            { toolDisplay: {}, status: '', i18n: ident },
        );
        expect(html).toContain('unknown_tool');
        expect(html).toContain('a: "short"');
        expect(html).not.toMatch(/.{120,}/);
    });

    it('does not render raw JSON.stringify(2) of args in the summary line', () => {
        const html = renderToolCallChip(
            { id: 'c4', name: 'x', args: { huge: 'value '.repeat(60) } },
            { toolDisplay: {}, status: '', i18n: ident },
        );
        const summaryMatch = html.match(/<div class="luker_lib_toolcall_summary">([\s\S]*?)<\/div>/);
        expect(summaryMatch).not.toBeNull();
        expect(summaryMatch[1].length).toBeLessThan(200);
    });

    it('renders an empty status (no icon) when status is unset', () => {
        const html = renderToolCallChip(
            { id: 'c5', name: 'x', args: {} },
            { toolDisplay: {}, i18n: ident },
        );
        expect(html).not.toContain('✅');
        expect(html).not.toContain('❌');
        expect(html).not.toContain('⏳');
    });

    it('renders details block with per-field args (not JSON dump)', () => {
        const html = renderToolCallChip(
            { id: 'c6', name: 'x', args: { field: 'description', value: 'hi', mode: 'replace' } },
            { toolDisplay: {}, i18n: ident },
        );
        expect(html).toContain('<details');
        expect(html).toContain('luker_lib_toolcall_arg_row');
        expect(html).toContain('field');
        expect(html).toContain('mode');
        // No raw stringified args block:
        expect(html).not.toMatch(/<pre[^>]*>\s*\{/);
    });

    it('escapes HTML in tool name + arg values', () => {
        const html = renderToolCallChip(
            { id: 'c7', name: '<script>', args: { x: '<img onerror=1>' } },
            { toolDisplay: {}, i18n: ident },
        );
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img onerror=1>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('keeps result details closed by default (reference material, expand on demand)', () => {
        const html = renderToolCallChip(
            { id: 'cr1', name: 'r', args: {} },
            { toolDisplay: {}, result: 'short string', i18n: ident },
        );
        expect(html).toMatch(/<details class="luker_lib_toolcall_result"\s*>/);
        expect(html).not.toMatch(/<details class="luker_lib_toolcall_result" open/);
    });

    it('closes result details for empty object results', () => {
        const html = renderToolCallChip(
            { id: 'cr2', name: 'r', args: {} },
            { toolDisplay: {}, result: {}, i18n: ident },
        );
        expect(html).toMatch(/<details class="luker_lib_toolcall_result"\s*>/);
        expect(html).not.toMatch(/<details class="luker_lib_toolcall_result" open/);
    });

    it('renders multi-field object result as full JSON, expanding nested values instead of collapsing to {…}', () => {
        const html = renderToolCallChip(
            { id: 'cr3', name: 'r', args: {} },
            {
                toolDisplay: {},
                result: {
                    book_name: 'lore',
                    total_hits: 2,
                    entries: [
                        { uid: 7, comment: 'first', matched_excerpt: 'alpha snippet' },
                        { uid: 9, comment: 'second', matched_excerpt: 'beta snippet' },
                    ],
                },
                i18n: ident,
            },
        );
        // Pretty-printed JSON should expose every nested field — the bug was
        // that arrays of objects rendered as `[ {…}, {…} ]` so users on mobile
        // could never read the actual returned values.
        expect(html).toContain('luker_lib_toolcall_result_pre');
        expect(html).toContain('book_name');
        expect(html).toContain('total_hits');
        expect(html).toContain('entries');
        expect(html).toContain('first');
        expect(html).toContain('alpha snippet');
        expect(html).toContain('second');
        expect(html).toContain('beta snippet');
        // No `{…}` collapse anywhere in the result body:
        expect(html).not.toContain('{…}');
    });

    it('renders string results verbatim so newlines and structure survive', () => {
        const html = renderToolCallChip(
            { id: 'cr3s', name: 'r', args: {} },
            { toolDisplay: {}, result: 'line one\nline two\nline three', i18n: ident },
        );
        expect(html).toContain('luker_lib_toolcall_result_pre');
        expect(html).toContain('line one');
        expect(html).toContain('line two');
        expect(html).toContain('line three');
    });

    it('truncatedKvSummary always emits at least one (truncated) pair on overflow', () => {
        // Use a single arg whose key+value exceeds the 60-char summary budget.
        const longKey = 'someVeryLongArgumentNameThatExceedsFortyFiveChars';
        const html = renderToolCallChip(
            { id: 'cr4', name: 'x', args: { [longKey]: 'someValueAlsoLongerThanTwentyChars' } },
            { toolDisplay: {}, status: '', i18n: ident },
        );
        // Summary must include some of the long key, not just "… (1 more)":
        const summaryMatch = html.match(/<span class="luker_lib_toolcall_summary_text">([^<]*)<\/span>/);
        expect(summaryMatch).not.toBeNull();
        expect(summaryMatch[1].length).toBeGreaterThan(5);
        expect(summaryMatch[1]).toContain('…');
        // Must contain part of the key (proves we didn't drop to "… (1 more)" with no content):
        expect(summaryMatch[1]).toMatch(/someVeryLong/);
    });

    it('translates the chip label via opts.i18n at render time', () => {
        // tool-display modules carry English source strings as labels (the
        // i18n keys). The chip renderer must run them through opts.i18n so
        // a popup whose translator maps the key to Chinese sees the
        // translated label, not the English source.
        const html = renderToolCallChip(
            { id: 't1', name: 'preset_read_live_fields', args: { paths: ['p'] } },
            {
                toolDisplay: {
                    preset_read_live_fields: { icon: '📖', label: 'Read preset fields', type: 'read' },
                },
                i18n: (s) => s === 'Read preset fields' ? '读取预设字段' : s,
            },
        );
        expect(html).toContain('读取预设字段');
        expect(html).not.toContain('Read preset fields');
    });

    it('threads opts.i18n into summarize as the 3rd argument', () => {
        // Summarize callbacks declared in tool-display modules use English
        // template strings; the chip renderer hands them the popup's i18n
        // function so they can localize result digests.
        const summarize = (a, r, i18n) => {
            const tpl = (typeof i18n === 'function' ? i18n('Returned ${0} values') : 'Returned ${0} values');
            return tpl.replace('${0}', String(Object.keys(r || {}).length));
        };
        const html = renderToolCallChip(
            { id: 't2', name: 'preset_read_live_fields', args: { paths: ['p'] } },
            {
                toolDisplay: {
                    preset_read_live_fields: { icon: '📖', label: 'Read preset fields', type: 'read', summarize },
                },
                result: { alpha: 1, beta: 2 },
                i18n: (s) => s === 'Returned ${0} values' ? '返回了 ${0} 个值' : s,
            },
        );
        // Summary line carries the translated template with the count substituted.
        expect(html).toContain('返回了 2 个值');
        expect(html).not.toContain('Returned 2 values');
    });
});
