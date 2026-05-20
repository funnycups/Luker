// Stub adapter for shell tests. Lives in tests/ so it is NOT shipped.
// Implements the minimal new contract. Tests construct fresh instances
// per test to isolate state.

export function createStubAdapter(initialLive = {}) {
    const state = {
        live: structuredClone(initialLive),
        sessions: new Map(),                  // id -> Session
        commitHistory: [],
        clearObsoleteCalled: 0,
    };

    return {
        id: 'stub',
        title: 'Stub',
        mode: 'stub',
        layout: 'popup',

        i18n: (key) => key,
        i18nFormat: (key, ...args) => key + ':' + args.join('|'),

        live: () => structuredClone(state.live),
        commit: async (newLive) => {
            state.live = structuredClone(newLive);
            state.commitHistory.push(structuredClone(newLive));
        },
        sessionScope: () => 'test',

        listSessions: async () => {
            return [...state.sessions.values()]
                .map(s => ({ id: s.id, title: s.id, updatedAt: s.updatedAt }))
                .sort((a, b) => b.updatedAt - a.updatedAt);
        },
        loadSession: async (_scope, id) => {
            const s = state.sessions.get(id);
            return s ? structuredClone(s) : null;
        },
        saveSession: async (_scope, session) => {
            state.sessions.set(session.id, structuredClone(session));
        },
        deleteSession: async (_scope, id) => {
            state.sessions.delete(id);
        },
        clearObsoleteSessions: async () => {
            state.clearObsoleteCalled += 1;
        },

        buildToolCatalog: () => ([
            { type: 'function', function: { name: 'stub_set', description: 'set', parameters: { type: 'object' } } },
            { type: 'function', function: { name: 'stub_str_replace', description: 'str_replace', parameters: { type: 'object' } } },
        ]),
        classifyToolCall: (call) => (call?.name === 'stub_control' ? 'control' : 'editable'),
        normalizeToolCallToEdit: (call) => {
            const args = call?.args || {};
            if (call?.name === 'stub_set') {
                return [{ op: 'set', path: String(args.path || ''), oldValue: args.oldValue, newValue: args.newValue }];
            }
            if (call?.name === 'stub_str_replace') {
                return [{ op: 'str_replace', path: String(args.path || ''), find: String(args.find || ''), replace: String(args.replace || '') }];
            }
            return null;
        },
        executeControlToolCall: async (_call) => ({ content: JSON.stringify({ ok: true }), action: 'control' }),

        buildSystemPrompt: () => 'stub system',
        buildUserPrompt: (_session, text) => `stub user: ${text}`,

        renderMessageCard: (message) => `<div class="stub-msg">${String(message.content || '')}</div>`,
        renderHistoryItem: (meta) => `<div class="stub-hist">${meta.id}</div>`,

        _state: state,   // exposed for tests
    };
}
