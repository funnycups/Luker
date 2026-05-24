import { jest } from '@jest/globals';
import { renderMessageCard } from '../../public/scripts/iteration-library/ui/message.js';

const ident = (s) => s;
const noopEdit = () => '<div class="edit-card"></div>';

describe('renderMessageCard', () => {
    it('renders user message body as escaped html with <br>', () => {
        const html = renderMessageCard(
            { id: 'm1', role: 'user', content: 'hello\nworld <script>' },
            { toolDisplay: {}, renderEditCard: noopEdit, isLast: false, i18n: ident },
        );
        expect(html).toContain('luker_lib_message_user');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('<br>');
    });

    it('renders system message in italic hint', () => {
        const html = renderMessageCard(
            { id: 'm2', role: 'system', content: 'profile reset' },
            { toolDisplay: {}, renderEditCard: noopEdit, isLast: false, i18n: ident },
        );
        expect(html).toContain('luker_lib_message_system');
    });

    it('renders assistant with markdown body via renderMarkdown opt', () => {
        const html = renderMessageCard(
            { id: 'm3', role: 'assistant', content: 'hi', toolCalls: [], edits: [] },
            { toolDisplay: {}, renderEditCard: noopEdit, isLast: true, i18n: ident, renderMarkdown: (s) => `<p>${s}</p>` },
        );
        expect(html).toContain('<p>hi</p>');
    });

    it('hides auto-continue user messages entirely (internal pipeline plumbing, not user content)', () => {
        const html = renderMessageCard(
            { id: 'm4', role: 'user', content: 'auto-continue', auto: true },
            { toolDisplay: {}, renderEditCard: noopEdit, isLast: false, i18n: ident },
        );
        // Auto-continue user messages carry an LLM-facing nudge
        // ("Continue with the next iteration step...") that the user
        // should never see in the chat. Rendering returns an empty
        // string so the auto round appears as a natural next-assistant
        // turn instead of a noisy "Auto-continue: <prompt>" line.
        expect(html).toBe('');
    });

    it('shows a read-only-round hint when all tool calls are read-type and no edits/finalize', () => {
        const html = renderMessageCard(
            {
                id: 'm5',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'preset_read_live_fields', args: { paths: ['x'] } }],
                toolResults: [{ tool_call_id: 'c1', content: { x: 'value' } }],
                edits: [],
            },
            {
                toolDisplay: { preset_read_live_fields: { type: 'read', icon: '📖', label: 'Read', summarize: () => '' } },
                renderEditCard: noopEdit, isLast: true, i18n: ident,
            },
        );
        expect(html).toMatch(/read|读/i);
        expect(html).toContain('luker_lib_message_readonly_hint');
    });

    it('passes tool result into tool-call chip via tool_call_id lookup', () => {
        const html = renderMessageCard(
            {
                id: 'm6',
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'r', args: {} }],
                toolResults: [{ tool_call_id: 'c1', content: { hits: 2 } }],
            },
            {
                toolDisplay: { r: { type: 'read', icon: '📖', label: 'Read', summarize: (_, res) => res ? `hits: ${res.hits}` : '' } },
                renderEditCard: noopEdit, isLast: true, i18n: ident,
            },
        );
        expect(html).toContain('hits: 2');
    });

    it('shows ✓ Applied stamp + Rollback button when message.appliedAt is set and not rolled back', () => {
        const html = renderMessageCard(
            { id: 'm7', role: 'assistant', content: 'x', edits: [{ op: 'set', path: 'a', oldValue: 1, newValue: 2 }], appliedAt: Date.now(), appliedTarget: 'character' },
            { toolDisplay: {}, renderEditCard: noopEdit, isLast: true, i18n: ident },
        );
        expect(html).toMatch(/Applied/);
        expect(html).toContain('rollback');
    });

    it('shows Rolled back stamp when message.rolledBackAt is set', () => {
        const html = renderMessageCard(
            { id: 'm8', role: 'assistant', content: 'x', edits: [], rolledBackAt: Date.now() },
            { toolDisplay: {}, renderEditCard: noopEdit, isLast: true, i18n: ident },
        );
        expect(html).toMatch(/Rolled back|回滚|回退/);
    });

    it('shows Regenerate button on non-last assistant message, hides on last + on auto-continue', () => {
        const last = renderMessageCard(
            { id: 'm9', role: 'assistant', content: 'x' },
            { toolDisplay: {}, renderEditCard: noopEdit, isLast: true, i18n: ident },
        );
        expect(last).not.toContain('regenerate');

        const mid = renderMessageCard(
            { id: 'm10', role: 'assistant', content: 'x' },
            { toolDisplay: {}, renderEditCard: noopEdit, isLast: false, i18n: ident },
        );
        expect(mid).toContain('regenerate');

        const auto = renderMessageCard(
            { id: 'm11', role: 'assistant', content: 'x', auto: true },
            { toolDisplay: {}, renderEditCard: noopEdit, isLast: false, i18n: ident },
        );
        expect(auto).not.toContain('regenerate');
    });

    it('translates appliedTarget through i18n in the applied-stamp line', () => {
        // The applied-line carries `message.appliedTarget` as the first
        // interpolation arg. The renderer must run that target value
        // through opts.i18n before substituting it so stored English
        // keys ('preset', 'schema', 'character') surface in the user's
        // locale at render time. Before the fix, the target flowed
        // straight into the template as raw English.
        const dict = { preset: '预设' };
        const i18n = (s, ...vals) => {
            const tpl = Object.hasOwn(dict, s) ? dict[s] : s;
            return vals.reduce((acc, v, i) => acc.replace(new RegExp('\\$\\{' + i + '\\}', 'g'), v), tpl);
        };
        const html = renderMessageCard(
            { id: 'm12', role: 'assistant', content: 'x', edits: [{ op: 'set' }], appliedAt: Date.now(), appliedTarget: 'preset' },
            { toolDisplay: {}, renderEditCard: noopEdit, isLast: true, i18n },
        );
        expect(html).toContain('预设');
        expect(html).not.toContain('Applied to preset at');
    });

    it('skips rendering an empty assistant turn entirely (no content / tools / edits / status)', () => {
        // Before the fix, an empty assistant turn rendered an empty
        // bordered card that suggested "something is here" when nothing
        // is. We now short-circuit to an empty string so the chat
        // surface stays clean. Status / regen affordances are only
        // present when a non-empty signal exists.
        const html = renderMessageCard(
            { id: 'mEmpty', role: 'assistant', content: '' },
            { toolDisplay: {}, renderEditCard: noopEdit, isLast: true, i18n: ident },
        );
        expect(html).toBe('');
    });

    it('renders an assistant turn that carries only an applied stamp (no content / tools / edits)', () => {
        // The empty-card guard skips when ALL signals are absent — but
        // a turn carrying an applied stamp is meaningful even with no
        // body. Guard against over-skipping: status alone is enough.
        const html = renderMessageCard(
            { id: 'mApplied', role: 'assistant', content: '', appliedAt: Date.now() },
            { toolDisplay: {}, renderEditCard: noopEdit, isLast: true, i18n: ident },
        );
        expect(html).toContain('Applied');
    });
});
