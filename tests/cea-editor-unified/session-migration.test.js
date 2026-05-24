import { jest } from '@jest/globals';

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash };
});

let migrateLegacyCeaEditorSession;
beforeAll(async () => {
    ({ migrateLegacyCeaEditorSession } = await import(
        '../../public/scripts/extensions/character-editor-assistant/editor-iteration/session-migration.js'
    ));
});

describe('migrateLegacyCeaEditorSession', () => {
    it('exports the migration function', () => {
        expect(typeof migrateLegacyCeaEditorSession).toBe('function');
    });

    it('returns a new-shape session with messages from conversationMessages', () => {
        const legacy = {
            id: 'sess1',
            title: 'My session',
            avatar: 'avatar.png',
            conversationMessages: [
                { role: 'user', content: 'help me' },
                {
                    role: 'assistant',
                    content: 'sure',
                    tool_calls: [{ id: 't1', name: 'cea_set_card_field', args: { field: 'description', value: 'new' } }],
                    tool_results: [{ tool_call_id: 't1', content: { ok: true } }],
                },
            ],
            pendingApproval: { operations: [], diffPreviews: [] },
        };
        const out = migrateLegacyCeaEditorSession(legacy, { now: () => 1700000000000 });
        expect(out).not.toBeNull();
        expect(out.id).toBe('sess1');
        expect(out.title).toBe('My session');
        expect(Array.isArray(out.messages)).toBe(true);
        expect(out.messages.length).toBe(2);
        expect(out.messages[0].role).toBe('user');
        expect(out.messages[0].content).toBe('help me');
        expect(out.messages[1].role).toBe('assistant');
        expect(out.messages[1].toolCalls).toHaveLength(1);
        expect(out.messages[1].toolCalls[0].id).toBe('t1');
        expect(out.messages[1].toolResults).toHaveLength(1);
        expect(out.messages[1].toolResults[0].tool_call_id).toBe('t1');
    });

    it('maps pendingApproval into pendingEdits', () => {
        const legacy = {
            id: 'sess2',
            conversationMessages: [],
            pendingApproval: {
                operations: [
                    { type: 'set_card_field', args: { field: 'description', oldValue: 'old', newValue: 'new' } },
                ],
            },
        };
        const out = migrateLegacyCeaEditorSession(legacy);
        expect(Array.isArray(out.pendingEdits)).toBe(true);
        // The exact shape conversion is best-effort; verify at minimum that
        // pendingEdits is populated when pendingApproval had operations.
        expect(out.pendingEdits.length).toBeGreaterThan(0);
    });

    it('handles missing fields gracefully (sparse legacy session)', () => {
        const out = migrateLegacyCeaEditorSession({ id: 'sess3' });
        expect(out.id).toBe('sess3');
        expect(Array.isArray(out.messages)).toBe(true);
        expect(out.messages.length).toBe(0);
        expect(Array.isArray(out.pendingEdits)).toBe(true);
    });

    it('returns null for null/undefined/non-object input', () => {
        expect(migrateLegacyCeaEditorSession(null)).toBeNull();
        expect(migrateLegacyCeaEditorSession(undefined)).toBeNull();
        expect(migrateLegacyCeaEditorSession('not a session')).toBeNull();
    });

    it('is idempotent: migrating an already-new-shape session is a no-op clone', () => {
        const alreadyNew = {
            id: 'sess4',
            title: 't',
            avatar: 'a.png',
            messages: [{ id: 'm1', role: 'user', content: 'x', toolCalls: [], toolResults: [], edits: [], appliedAt: null, appliedTarget: '', rolledBackAt: null, auto: false, at: 1 }],
            pendingEdits: [],
            live: { character: {}, lorebooks: {} },
            surfaceState: { isFinalized: false },
        };
        const out = migrateLegacyCeaEditorSession(alreadyNew);
        expect(out.id).toBe('sess4');
        expect(out.messages.length).toBe(1);
    });

    it('preserves session title and avatar', () => {
        const legacy = {
            id: 'sess5',
            title: 'Important Session',
            avatar: 'special.png',
            conversationMessages: [{ role: 'user', content: 'hi' }],
        };
        const out = migrateLegacyCeaEditorSession(legacy);
        expect(out.title).toBe('Important Session');
        expect(out.avatar).toBe('special.png');
    });
});
