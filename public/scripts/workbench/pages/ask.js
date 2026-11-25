// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ask: read-only Q&A over Luker's data. Left: what it can see (live counts).
// Right: the conversation. Each answer shows what was read and roughly how
// much went to the model; the fix button hands the finding to AI iteration.
// In-flight runs are isolated by runId / sessionId so switching sessions
// mid-flight never bleeds progress or stop controls across sessions.

import { i18n, i18nFormat } from '../i18n.js';
import { h, put, clear, formatTokens, relativeTime, copyText } from '../../lens-shared/util.js';
import { icon } from '../icons.js';
import { button, iconButton, checkRow, msgActions } from '../ui/components.js';
import { renderMarkdown } from '../ui/markdown.js';
import { runAsk, readsSummary, buildAskHistory } from '../model/ask.js';
import { finishOverview } from '../model/requests.js';
import { titleFrom } from '../model/sessions.js';
import { withActivityLease } from '../../activity-guard.js';

const CHIP_KEYS = [
    'Why was this reply written this way',
    'Why did that error happen',
    'Why did world book or variables not work',
    'Which extension uses the most tokens',
    'Write a bug report for me with the debug info',
];

const WS_NAME_KEYS = {
    memory: 'Memory graph config',
    memory_graph: 'Memory graph content',
    orch: 'Orchestration',
    sd: 'Image Generation',
    preset: 'Preset',
    card: 'Character card',
    world: 'World book',
};

export function chips() {
    return CHIP_KEYS.map(i18n);
}

export function wsName(id) {
    const key = WS_NAME_KEYS[id];
    return key ? i18n(key) : '';
}

function scopeKey(scope) {
    if (!scope || scope.scope !== 'chat') return 'global';
    const t = scope.target;
    if (!t) return 'chat:active';
    return t.is_group
        ? `chat:group:${String(t.id || '')}`
        : `chat:${String(t.avatar_url || '')}:${String(t.file_name || '')}`;
}

export function createAskPage(app) {
    const store = app.sessions;
    const side = h('aside', { class: 'wb-src' });
    const chatHead = h('div', { class: 'wb-chat-head' });
    const body = h('div', { class: 'wb-chat-body' });
    const input = h('textarea', { class: 'wb-input', rows: 1, placeholder: i18n('Ask anything, for example: why did she suddenly forget yesterday?'), 'aria-label': i18n('Q&A') });
    const sendBtn = button(i18n('Send'), () => send(), { iconName: 'send', className: 'is-primary wb-send' });
    const chipsRow = h('div', { class: 'wb-chips' });
    const opts = h('div', { class: 'wb-composer-opts' });
    const composer = h('div', { class: 'wb-composer' }, chipsRow, h('div', { class: 'wb-input-row' }, input, sendBtn), opts);
    const chat = h('section', { class: 'wb-chat' }, chatHead, body, composer);
    const el = h('div', { class: 'wb-page is-split' }, side, chat);

    function paintChips() {
        clear(chipsRow);
        put(chipsRow, chips().map(c => h('button', { type: 'button', class: 'wb-chip', onClick: () => { input.value = c; grow(); input.focus({ preventScroll: true }); } }, c)));
    }
    paintChips();

    let session = null;
    let recentSessions = [];
    const sessionScopes = new Map();
    let selectionVersion = 0;
    let pendingNewSelection = -1;
    let refreshVersion = 0;
    const activeRuns = new Map();
    let sideOpen = false;
    let counts = null;

    function validChatTarget(t) {
        if (!t || typeof t !== 'object') return null;
        if (t.is_group === true && typeof t.id === 'string' && t.id) return { is_group: true, id: t.id };
        if (t.is_group !== true && typeof t.avatar_url === 'string' && t.avatar_url && typeof t.file_name === 'string' && t.file_name) {
            return {
                is_group: false,
                avatar_url: t.avatar_url,
                file_name: t.file_name,
                ...(typeof t.char_name === 'string' && t.char_name ? { char_name: t.char_name } : {}),
            };
        }
        return null;
    }

    function currentScope() {
        const snap = app.snapshot?.();
        const ctx = globalThis.Luker?.getContext?.() ?? globalThis.lukerContext ?? null;
        const resolved = validChatTarget(snap?.chat?.target) || validChatTarget(ctx?.resolveChatStateTarget?.());
        if (resolved) return { scope: 'chat', target: resolved };
        if (ctx?.groupId && Array.isArray(ctx.groups)) {
            const g = ctx.groups.find(x => String(x.id) === String(ctx.groupId));
            const id = String(g?.chat_id || snap?.chat?.chatId || '').trim();
            if (id) return { scope: 'chat', target: { is_group: true, id } };
        }
        const ch = Array.isArray(ctx?.characters) ? ctx.characters[ctx?.characterId] : null;
        const avatar = String(ch?.avatar || snap?.card?.avatar || '').trim();
        const file = String(ch?.chat || snap?.chat?.chatId || '').trim();
        if (avatar && file) {
            return { scope: 'chat', target: { is_group: false, avatar_url: avatar, file_name: file } };
        }
        const rawChatId = ctx?.getCurrentChatId?.();
        const hasChatId = Boolean(snap?.chat?.chatId || (typeof rawChatId === 'string' && rawChatId));
        return hasChatId ? { scope: 'chat' } : { scope: 'global' };
    }

    let activeScopeKey = scopeKey(currentScope());

    function scopeOf(s) {
        return (s?.id && sessionScopes.get(s.id)) || currentScope();
    }

    function activeRunForSession(sessionId) {
        if (!sessionId) return null;
        for (const run of activeRuns.values()) {
            if (run.sessionId === sessionId) return run;
        }
        return null;
    }

    function currentBusy() {
        return Boolean((session?.id && activeRunForSession(session.id)) || (!session && pendingNewSelection === selectionVersion));
    }

    function grow() {
        input.style.height = 'auto';
        input.style.height = `${Math.min(120, input.scrollHeight)}px`; // cap-ok: matches .wb-input max-height: 120px viewport layout constraint in css/chat.css
    }
    input.addEventListener('input', grow);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !globalThis.matchMedia?.('(hover: none)').matches) {
            event.preventDefault();
            send();
        }
    });

    // ----- Left: sources ---------------------------------------------------
    async function loadCounts() {
        const s = app.source;
        const settled = await Promise.allSettled([s.listRequests?.({ limit: 200 }), s.frontendLogCount?.()]);
        counts = {
            requests: settled[0].status === 'fulfilled' ? settled[0].value?.length ?? null : null,
            requestsError: settled[0].status === 'rejected',
            logs: settled[1].status === 'fulfilled' ? settled[1].value : null,
            debug: s.debugLoggingOn?.() ?? null,
        };
        paintSide();
    }

    function paintSide() {
        clear(side);
        side.classList.toggle('is-open', sideOpen);
        const snap = app.snapshot();
        const allowed = app.settings().ask?.sources || {};
        const item = (name, n, key, state = 'ok') => h('div', { class: 'wb-src-item' },
            h('span', { class: `wb-src-st is-${allowed[key] === false ? 'off' : state}`, 'aria-hidden': 'true' }),
            h('span', { class: 'wb-src-name', text: name }),
            h('span', { class: 'wb-src-n', text: allowed[key] === false ? i18n('Not read') : n }));
        const c = counts;

        const providerItems = [];
        for (const p of app.askProviders?.() || []) {
            const pSnap = snap?.providers?.[p.id];
            const info = typeof p.getSideInfo === 'function' ? p.getSideInfo(pSnap, snap) : null;
            if (info) {
                providerItems.push(item(info.label || p.label || p.id, info.countText || '—', 'plugins', info.status || 'ok'));
            }
        }

        const ctx = globalThis.Luker?.getContext?.() ?? globalThis.lukerContext ?? null;
        const varKeysCount = Object.keys(ctx?.chatMetadata?.variables || {}).length;
        const regexExtensionDisabled = Array.isArray(ctx?.extensionSettings?.disabledExtensions)
            && ctx.extensionSettings.disabledExtensions.includes('regex');
        let regexEnabledCount = null;
        if (!regexExtensionDisabled && typeof ctx?.regex?.getScripts === 'function') {
            try {
                regexEnabledCount = (ctx.regex.getScripts({ allowedOnly: true }) || []).filter(s => s && !s.disabled).length;
            } catch { regexEnabledCount = null; }
        }
        const anySourceOn = allowed.inspector !== false || allowed.frontLogs !== false || allowed.serverLogs !== false || allowed.content !== false || allowed.plugins !== false;

        put(side,
            h('div', { class: 'wb-src-head' },
                h('div', { class: 'wb-src-title', text: i18n('What Ask can see') }),
                h('p', { class: 'wb-note', text: i18n('Everything is read locally, and only what the answer needs goes to the AI.') }),
                sideOpen ? iconButton('x', i18n('Off'), () => { sideOpen = false; paintSide(); }, { className: 'wb-src-close' }) : null),
            h('div', { class: 'wb-src-list' },
                h('div', { class: 'wb-src-group', text: i18n('Run records') }),
                item(i18n('Request inspector'), c ? (c.requestsError ? i18n('Unreadable') : i18nFormat('${0} requests', c.requests ?? 0)) : '…', 'inspector', c?.requestsError ? 'warn' : 'ok'),
                item(i18n('Frontend logs'), c?.logs == null ? '…' : i18nFormat('${0} lines', c.logs.toLocaleString()), 'frontLogs', c?.debug === false ? 'warn' : 'ok'),
                item(i18n('Server logs'), i18n('Read when needed'), 'serverLogs'),
                c?.debug === false && allowed.frontLogs !== false ? h('div', { class: 'wb-src-warn' },
                    h('div', { text: i18n('"Frontend debug logging" is off, so API request logs are not being kept.') }),
                    button(i18n('Turn it on'), () => {
                        try { app.source.enableDebugLogging(); app.toast(i18n('Frontend debug logging is on')); loadCounts(); } catch (err) { app.toast(String(err?.message || err), { error: true }); }
                    }, { className: 'is-sm' })) : null,
                h('div', { class: 'wb-src-group', text: i18n('Current content') }),
                item(i18n('This chat'), snap?.chat?.label ? i18nFormat('${0} floors', snap.chat.floors) : i18n('Not open'), 'content'),
                item(i18n('Character card'), snap?.card?.name || i18n('None selected'), 'content'),
                item(i18n('World book'), snap?.card?.books?.length ? i18nFormat('${0} book(s)', snap.card.books.length) : '—', 'content'),
                item(i18n('Preset'), snap?.preset?.name || '—', 'content'),
                item(i18n('Variables'), varKeysCount > 0 ? i18nFormat('${0} keys', varKeysCount) : '—', 'content'),
                item(
                    i18n('Regex scripts'),
                    regexExtensionDisabled ? i18n('Off') : (regexEnabledCount == null ? '—' : i18nFormat('${0} enabled', regexEnabledCount)),
                    'content',
                    regexExtensionDisabled ? 'off' : 'ok',
                ),
                item(i18n('Connection profile'), snap?.connection || '—', 'content'),
                h('div', { class: 'wb-src-group', text: i18n('Installed extensions') }),
                providerItems,
                item(i18n('Luker docs'), anySourceOn ? i18n('Built-in') : i18n('Not read'), 'docs', anySourceOn ? 'ok' : 'off'),
                item(i18n('Suggestions'), i18nFormat('${0} suggestion items', app.suggestions().length), 'plugins')),
            h('div', { class: 'wb-src-foot' }, button(i18n('Adjust in Settings'), () => app.go('settings'), { className: 'is-ghost is-sm' })));
    }

    async function refreshRecent() {
        const scope = currentScope();
        const key = scopeKey(scope);
        const ver = ++refreshVersion;
        if (!store) {
            recentSessions = [];
            return;
        }
        try {
            const list = await store.list('ask', scope);
            if (ver !== refreshVersion || key !== activeScopeKey) return;
            for (const s of list) sessionScopes.set(s.id, scope);
            recentSessions = list;
        } catch (err) {
            if (ver === refreshVersion) app.toast(String(err?.message || err), { error: true });
        }
    }

    // ----- Right: conversation ---------------------------------------------
    function paintHead() {
        clear(chatHead);
        const recent = recentSessions.slice(0, 8);
        put(chatHead,
            iconButton('list', i18n('What it can see'), () => { sideOpen = true; paintSide(); }, { className: 'wb-src-toggle' }),
            h('span', { class: 'wb-chat-title', text: i18n('Q&A') }),
            h('span', { class: 'wb-note wb-chat-tag', text: i18n('Read-only — nothing gets changed') }),
            h('span', { class: 'wb-spacer' }),
            recent.length ? historyMenu(recent) : null,
            button(i18n('New conversation'), () => {
                selectionVersion++;
                session = null;
                paintHead();
                paintBody();
                input.focus({ preventScroll: true });
            }, { iconName: 'plus', className: 'is-ghost wb-chat-new', title: i18n('New conversation') }));
    }

    function historyMenu(recent) {
        const sel = h('select', { class: 'lw-select wb-chat-hist', 'aria-label': i18n('Earlier chats') },
            h('option', { value: '', text: i18n('Earlier chats') }),
            recent.map(s => h('option', { value: s.id, text: `${s.title} · ${relativeTime(s.updatedAt)}` })));
        sel.value = session?.id || '';
        sel.addEventListener('change', async () => {
            const pickedId = sel.value;
            const version = ++selectionVersion;
            if (!pickedId) {
                session = null;
                paintHead();
                paintBody();
                return;
            }
            const cached = recentSessions.find(s => s.id === pickedId) || null;
            if (cached) {
                session = cached;
                paintBody();
            }
            if (!store) return;
            try {
                const loaded = await store.get(pickedId, sessionScopes.get(pickedId) || currentScope());
                if (version !== selectionVersion) return;
                session = loaded || cached;
                paintBody();
            } catch (err) {
                if (version === selectionVersion) app.toast(String(err?.message || err), { error: true });
            }
        });
        return sel;
    }

    function paintBody() {
        clear(body);
        const busy = currentBusy();
        const run = session?.id ? activeRunForSession(session.id) : null;
        const turns = session?.turns || [];
        if (!turns.length && !busy) {
            put(body, h('div', { class: 'wb-empty' },
                icon('ask', { size: 28 }),
                h('b', { text: i18n('Ask whatever you want to know') }),
                h('div', { text: i18n('For example: "why did this reply take so long", "why did she forget yesterday\'s promise", "which extension uses the most tokens". Ask looks through requests, logs, character cards and the memory graph by itself.') })));
        }
        if (session?.forkedFrom) put(body, h('div', { class: 'wb-fork-note', text: i18nFormat('Branched from "${0}"', session.forkedFrom) }));
        turns.forEach((t, i) => put(body, t.role === 'user' ? userBlock(t, i, busy) : answerBlock(t, i, busy)));
        if (busy) {
            const liveSteps = run?.steps || [];
            put(body, h('div', { class: 'wb-msg-ai' },
                h('div', { class: 'wb-reads is-live' }, h('span', { class: 'wb-spinner', 'aria-hidden': 'true' }),
                    h('span', { text: liveSteps.length ? i18nFormat('Reading ${0}…', readsSummary(liveSteps)) : i18n('Thinking it over…') })),
                run ? button(i18n('Stop answering'), () => run.abort?.abort(), { iconName: 'stop', className: 'is-ghost is-sm' }) : null));
        }
        requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
        paintOpts();
    }

    // ----- message actions ------------------------------------------------
    const isLast = (i) => i === (session?.turns?.length || 0) - 1;

    function userBlock(t, i, busy) {
        return h('div', { class: 'wb-msg-turn' },
            h('div', { class: 'wb-msg-me', text: t.text }),
            msgActions([
                { iconName: 'copy', label: i18n('Copy'), done: i18n('Copied'), onClick: () => copyText(t.text) },
                { iconName: 'edit', label: i18n('Edit and ask'), title: i18n('Edit this question in a new branch — the original chat stays as it is'), disabled: busy, onClick: () => editQuestion(i) },
            ]));
    }

    function answerText(t) {
        return t.error || [t.answer, t.fixPrompt ? `\n${i18nFormat('Suggested fix in "${0}": ${1}', wsName(t.suggest), t.fixPrompt)}` : ''].join('').trim();
    }

    /** New session holding turns [0, upto). */
    async function forkAt(upto) {
        if (!store || !session) return null;
        const src = session;
        const scope = scopeOf(src);
        const turns = src.turns.slice(0, upto);
        try {
            const created = await store.create({ kind: 'ask', title: i18nFormat('${0} (branch)', src.title), forkedFrom: src.title, turns }, scope);
            sessionScopes.set(created.id, scope);
            selectionVersion++;
            session = created;
            await refreshRecent();
            paintHead();
            paintBody();
            return created;
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
            return null;
        }
    }

    async function editQuestion(i) {
        if (!session) return;
        const text = session.turns[i].text;
        const created = await forkAt(i);
        if (!created) return;
        input.value = text;
        grow();
        input.focus({ preventScroll: true });
    }

    async function regenerate() {
        if (!session || !store) return;
        const version = selectionVersion;
        const targetId = session.id;
        const turns = session.turns;
        const q = turns[turns.length - 2];
        if (currentBusy() || !q || q.role !== 'user') return;
        const scope = scopeOf(session);
        try {
            const updated = await store.update(targetId, { turns: turns.slice(0, -2) }, scope);
            if (version !== selectionVersion || session?.id !== targetId) return;
            if (updated) session = updated;
            input.value = q.text;
            await send();
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
        }
    }

    function answerBlock(t, i, busy) {
        const reads = readsSummary(t.reads || []);
        const acts = msgActions([
            { iconName: 'copy', label: i18n('Copy'), done: i18n('Copied'), disabled: !answerText(t), onClick: () => copyText(answerText(t)) },
            isLast(i) ? { iconName: 'refresh', label: i18n('Answer again'), disabled: busy, onClick: () => regenerate() } : null,
            { iconName: 'fork', label: i18n('Branch from here'), title: i18n('Copy up to this message into a new chat and continue there'), disabled: busy, onClick: async () => {
                const forked = await forkAt(i + 1);
                if (forked) {
                    app.toast(i18n('Branched into a new chat — the original is still in Earlier chats'));
                    input.focus({ preventScroll: true });
                }
            } },
        ]);
        const askSources = app.settings().ask?.sources || {};
        const reqIds = Array.isArray(t.requestIds) ? [...new Set(t.requestIds.map(String).filter(Boolean))] : [];
        const openReq = async (reqId) => {
            if (typeof app.source.openRequestInspector === 'function') {
                try {
                    await app.source.openRequestInspector(reqId);
                    return;
                } catch { /* 回退到复制 ID */ }
            }
            copyText(reqId);
            app.toast(i18n('Request ID copied'));
        };
        const snap = app.snapshot?.();
        const hasOpenChat = Boolean(snap?.chat?.chatId || snap?.chat?.label);
        const registeredTargets = app.iterateTargets?.() || [];
        const canJumpSuggest = Boolean(
            t.suggest
            && wsName(t.suggest)
            && (t.suggest !== 'memory_graph' || hasOpenChat)
            && (!registeredTargets.length || registeredTargets.some(target => target?.id === t.suggest)),
        );
        return h('div', { class: 'wb-msg-ai' },
            reads ? h('div', { class: 'wb-reads' }, icon('eye', { size: 12 }), h('span', { text: i18nFormat('Read ${0}', reads) })) : null,
            t.error ? h('div', { class: 'wb-msg-error', text: t.error }) : renderMarkdown(t.answer),
            reqIds.length ? h('div', { class: 'wb-req-links' },
                reqIds.map(id => h('button', {
                    type: 'button',
                    class: 'wb-req-link',
                    title: i18nFormat('Inspect request ${0}', id),
                    onClick: () => void openReq(id),
                }, icon('eye', { size: 11 }), h('span', { text: id.length > 18 ? `${id.slice(0, 16)}…` : id })))) : null,
            canJumpSuggest ? h('div', { class: 'wb-ans-acts' },
                button(i18nFormat('Go edit ${0}', wsName(t.suggest)), () => app.go('ai', { ws: t.suggest, draft: t.fixPrompt || '', from: t.answer }), { iconName: 'spark' })) : null,
            t.sent ? h('details', { class: 'wb-sent' },
                h('summary', null, icon('up', { size: 12 }), h('span', { text: i18nFormat('Sent to the AI (about ${0} tokens)', formatTokens(Math.round(t.sent / 1.6))) })),
                h('ul', null,
                    h('li', { text: askSources.inspector !== false ? i18n('The question and an overview (chat, preset, prompt usage, status of the last 8 requests)') : i18n('The question and an overview (chat, preset, prompt usage)') }),
                    (t.reads || []).map(r => h('li', { text: i18nFormat('${0}${1} (${2} characters)', readsSummary([r]), r.args && Object.keys(r.args).length ? i18nFormat(': ${0}', JSON.stringify(r.args)) : '', r.chars.toLocaleString()) })),
                    app.settings().ask?.redact !== false ? h('li', { text: i18n('API keys and endpoint addresses were removed') }) : null)) : null,
            acts);
    }

    function paintOpts() {
        clear(opts);
        const s = app.settings();
        const busy = currentBusy();
        put(opts, checkRow({
            checked: s.ask?.previewBeforeSend,
            label: i18n('Show me before sending to the AI'),
            onChange: (v) => { const n = JSON.parse(JSON.stringify(app.settings())); n.ask = n.ask || {}; n.ask.previewBeforeSend = v; app.saveSettings(n); },
        }));
        sendBtn.disabled = busy;
        input.disabled = busy;
    }

    async function send() {
        const question = input.value.trim();
        if (!question || currentBusy() || !store) return;

        const selection = selectionVersion;
        const startingSession = session;
        const ownerScope = startingSession ? scopeOf(startingSession) : currentScope();
        const stillViewingStart = () => selection === selectionVersion && session === startingSession;
        if (!startingSession) pendingNewSelection = selection;
        paintOpts();

        let ownerId = startingSession?.id || '';
        let runId = '';
        let controller = null;
        try {
            const s = app.settings();
            const askCfg = s.ask || {};
            const askSources = askCfg.sources || {};
            const filter = { sources: askSources, redactText: askCfg.redact !== false };
            let overview;
            try {
                overview = await app.source.askOverview(filter);
            } catch (err) {
                overview = finishOverview({ 错误: String(err?.message || err) }, filter);
            }
            if (askCfg.previewBeforeSend && !globalThis.confirm(i18nFormat('To be sent to the AI:\n\nQuestion: ${0}\n\nOverview:\n${1}\n\nThe AI will then read data as needed. Continue?', question, JSON.stringify(overview, null, 1).slice(0, 1500)))) {
                return;
            }

            const owner = startingSession || await store.create({ kind: 'ask', title: titleFrom(question) }, ownerScope);
            ownerId = owner.id;
            sessionScopes.set(ownerId, ownerScope);
            if (pendingNewSelection === selection) pendingNewSelection = -1;
            if (!startingSession && stillViewingStart()) session = owner;

            const started = (await store.get(ownerId, ownerScope)) || owner;
            const saveTo = async (patch) => {
                const updated = await store.update(ownerId, patch, ownerScope);
                if (updated) {
                    if (session?.id === ownerId) session = updated;
                    if (scopeKey(ownerScope) === activeScopeKey) {
                        const idx = recentSessions.findIndex(r => r.id === ownerId);
                        if (idx >= 0) recentSessions[idx] = updated;
                        else recentSessions = [updated, ...recentSessions];
                    }
                }
                return updated;
            };

            const priorTurns = Array.isArray(started.turns) ? started.turns : [];
            await saveTo({ turns: [...priorTurns, { role: 'user', text: question, at: Date.now() }] });
            if (session?.id === ownerId && input.value.trim() === question) {
                input.value = '';
                grow();
            }

            runId = `ask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
            controller = new AbortController();
            const run = { runId, sessionId: ownerId, abort: controller, steps: [] };
            activeRuns.set(runId, run);
            if (session?.id === ownerId) {
                paintHead();
                paintBody();
            }

            const history = buildAskHistory(priorTurns, 10);
            let turn;
            try {
                const result = await withActivityLease({
                    source: 'workbench:ask',
                    label: i18n('Workbench AI ask'),
                    scope: 'global',
                    onCancel: () => controller.abort(),
                }, () => runAsk({
                    question,
                    overview,
                    history,
                    sources: askSources,
                    extraTools: app.source.askToolsForProviders?.() || [],
                    signal: controller.signal,
                    readers: app.source.askReaders({ redactText: askCfg.redact !== false, suggestions: () => app.suggestions(), sources: askSources }),
                    request: (messages, tools) => app.source.aiRequest('ask', { messages, tools, signal: controller.signal }),
                    onStep: (step) => {
                        run.steps.push(step);
                        if (session?.id === ownerId) paintBody();
                    },
                }));
                turn = { role: 'ai', ...result, at: Date.now() };
            } catch (err) {
                turn = {
                    role: 'ai',
                    answer: '',
                    error: controller.signal.aborted ? i18n('Stopped.') : i18nFormat('Could not ask: ${0}', err?.message || err),
                    reads: run.steps.slice(),
                    at: Date.now(),
                };
            }

            const finished = await store.get(ownerId, ownerScope);
            if (finished) await saveTo({ turns: [...finished.turns, turn] });
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
        } finally {
            if (pendingNewSelection === selection) pendingNewSelection = -1;
            if (runId) activeRuns.delete(runId);
            await refreshRecent();
            paintHead();
            const viewingOwner = ownerId ? session?.id === ownerId : stillViewingStart();
            if (viewingOwner) {
                paintBody();
            } else {
                paintOpts();
            }
        }
    }

    async function syncScopeChange() {
        const nextScope = currentScope();
        const nextKey = scopeKey(nextScope);
        if (nextKey === activeScopeKey) return;
        activeScopeKey = nextKey;
        if (session && scopeKey(scopeOf(session)) !== nextKey) {
            selectionVersion++;
            session = null;
            paintBody();
        }
        recentSessions = [];
        paintHead();
        await refreshRecent();
        if (activeScopeKey === nextKey) paintHead();
    }

    return {
        el,
        flush: true,
        async show(o = {}) {
            activeScopeKey = scopeKey(currentScope());
            paintChips();
            paintSide();
            paintHead();
            paintBody();
            loadCounts();
            if (o.draft) { input.value = o.draft; grow(); }
            await refreshRecent();
            paintHead();
            requestAnimationFrame(() => input.focus({ preventScroll: true }));
        },
        onSnapshot() {
            paintSide();
            void syncScopeChange();
        },
        onEscape() {
            if (sideOpen) { sideOpen = false; paintSide(); return true; }
            const run = session?.id ? activeRunForSession(session.id) : null;
            if (run) { run.abort?.abort(); return true; }
            return false;
        },
        destroy() {
            for (const run of activeRuns.values()) run.abort?.abort();
            activeRuns.clear();
        },
    };
}
