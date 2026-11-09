// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ask: read-only Q&A over Luker's data. Left: what it can see (live counts).
// Right: the conversation. Each answer shows what was read and roughly how
// much went to the model; the fix button hands the finding to AI iteration.

import { i18n, i18nFormat } from '../i18n.js';
import { h, put, clear, formatTokens, relativeTime, copyText } from '../../lens-shared/util.js';
import { icon } from '../icons.js';
import { button, iconButton, checkRow, msgActions } from '../ui/components.js';
import { renderMarkdown } from '../ui/markdown.js';
import { runAsk, readsSummary } from '../model/ask.js';
import { finishOverview } from '../model/requests.js';
import { titleFrom } from '../model/sessions.js';

const CHIPS = [i18n('Why was this reply written this way'), i18n('Why did that error happen'), i18n('Which extension uses the most tokens'), i18n('What was in the prompt sent to the model this time'), i18n('Write a bug report for me with the debug info')];
const WS_NAME = { memory: i18n('Memory graph'), orch: i18n('Orchestration'), preset: i18n('Preset'), card: i18n('Character card'), world: i18n('World book') };

export function createAskPage(app) {
    const store = app.sessions;
    const side = h('aside', { class: 'wb-src' });
    const chatHead = h('div', { class: 'wb-chat-head' });
    const body = h('div', { class: 'wb-chat-body' });
    const input = h('textarea', { class: 'wb-input', rows: 1, placeholder: i18n('Ask anything, for example: why did she suddenly forget yesterday?'), 'aria-label': i18n('Q&A') });
    const sendBtn = button(i18n('Send'), () => send(), { iconName: 'send', className: 'is-primary wb-send' });
    const chips = h('div', { class: 'wb-chips' }, CHIPS.map(c => h('button', { type: 'button', class: 'wb-chip', onClick: () => { input.value = c; grow(); input.focus(); } }, c)));
    const opts = h('div', { class: 'wb-composer-opts' });
    const composer = h('div', { class: 'wb-composer' }, chips, h('div', { class: 'wb-input-row' }, input, sendBtn), opts);
    const chat = h('section', { class: 'wb-chat' }, chatHead, body, composer);
    const el = h('div', { class: 'wb-page is-split' }, side, chat);

    let session = null;
    let busy = false;
    let abort = null;
    let steps = [];
    let sideOpen = false;
    let counts = null;

    function grow() {
        input.style.height = 'auto';
        input.style.height = `${Math.min(120, input.scrollHeight)}px`;
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
        const allowed = app.settings().ask.sources;
        const item = (name, n, key, state = 'ok') => h('div', { class: 'wb-src-item' },
            h('span', { class: `wb-src-st is-${allowed[key] === false ? 'off' : state}`, 'aria-hidden': 'true' }),
            h('span', { class: 'wb-src-name', text: name }),
            h('span', { class: 'wb-src-n', text: allowed[key] === false ? i18n('Not read') : n }));
        const c = counts;
        put(side,
            h('div', { class: 'wb-src-head' },
                h('div', { class: 'wb-src-title', text: i18n('What Ask can see') }),
                h('p', { class: 'wb-note', text: i18n('Everything is read locally; only what the answer needs goes to the AI.') }),
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
                item(i18n('Connection profile'), snap?.connection || '—', 'content'),
                h('div', { class: 'wb-src-group', text: i18n('Installed extensions') }),
                item(i18n('Memory graph'), snap?.memory ? i18nFormat('${0} nodes', snap.memory.nodes) : i18n('Not present'), 'plugins'),
                item(i18n('Orchestration'), snap?.orch ? i18nFormat('${0} orchestrator runs', snap.orch.runs.length) : i18n('Not present'), 'plugins'),
                item(i18n('Suggestions'), i18nFormat('${0} suggestion items', app.suggestions().length), 'plugins')),
            h('div', { class: 'wb-src-foot' }, button(i18n('Adjust in Settings'), () => app.go('settings'), { className: 'is-ghost is-sm' })));
    }

    // ----- Right: conversation ---------------------------------------------
    function paintHead() {
        clear(chatHead);
        const recent = store.list('ask').slice(0, 8);
        put(chatHead,
            iconButton('list', i18n('What it can see'), () => { sideOpen = true; paintSide(); }, { className: 'wb-src-toggle' }),
            h('span', { class: 'wb-chat-title', text: i18n('Q&A') }),
            h('span', { class: 'wb-note wb-chat-tag', text: i18n('Read-only; nothing gets changed') }),
            h('span', { class: 'wb-spacer' }),
            recent.length ? historyMenu(recent) : null,
            button(i18n('New conversation'), () => { session = null; steps = []; paintHead(); paintBody(); input.focus(); }, { iconName: 'plus', className: 'is-ghost wb-chat-new', title: i18n('New conversation') }));
    }

    function historyMenu(recent) {
        const sel = h('select', { class: 'wb-select wb-chat-hist', 'aria-label': i18n('Earlier chats') },
            h('option', { value: '', text: i18n('Earlier chats') }),
            recent.map(s => h('option', { value: s.id, text: `${s.title} · ${relativeTime(s.updatedAt)}` })));
        sel.value = session?.id || '';
        sel.addEventListener('change', () => { session = store.get(sel.value); steps = []; paintBody(); });
        return sel;
    }

    function paintBody() {
        clear(body);
        const turns = session?.turns || [];
        if (!turns.length && !busy) {
            put(body, h('div', { class: 'wb-empty' },
                icon('ask', { size: 28 }),
                h('b', { text: i18n('Ask whatever you want to know') }),
                h('div', { text: i18n('For example: "why did this reply take so long", "why did she forget yesterday\'s promise", "which extension uses the most tokens". Ask looks through requests, logs, character cards and the memory graph by itself.') })));
        }
        if (session?.forkedFrom) put(body, h('div', { class: 'wb-fork-note', text: i18nFormat('Branched from "${0}"', session.forkedFrom) }));
        turns.forEach((t, i) => put(body, t.role === 'user' ? userBlock(t, i) : answerBlock(t, i)));
        if (busy) {
            put(body, h('div', { class: 'wb-msg-ai' },
                h('div', { class: 'wb-reads is-live' }, h('span', { class: 'wb-spinner', 'aria-hidden': 'true' }),
                    h('span', { text: steps.length ? i18nFormat('Reading ${0}…', readsSummary(steps)) : i18n('Thinking it over…') })),
                button(i18n('Stop answering'), () => abort?.abort(), { iconName: 'stop', className: 'is-ghost is-sm' })));
        }
        requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
        paintOpts();
    }

    // ----- message actions ------------------------------------------------
    const isLast = (i) => i === (session?.turns?.length || 0) - 1;

    function userBlock(t, i) {
        return h('div', { class: 'wb-msg-turn' },
            h('div', { class: 'wb-msg-me', text: t.text }),
            msgActions([
                { iconName: 'copy', label: i18n('Copy'), done: i18n('Copied'), onClick: () => copyText(t.text) },
                { iconName: 'edit', label: i18n('Edit and ask'), title: i18n('Edit this question in a new branch; the original chat stays as it is'), disabled: busy, onClick: () => editQuestion(i) },
            ]));
    }

    function answerText(t) {
        return t.error || [t.answer, t.fixPrompt ? `\n${i18nFormat('Suggested fix in "${0}": ${1}', WS_NAME[t.suggest] || '', t.fixPrompt)}` : ''].join('').trim();
    }

    /** New session holding turns [0, upto). */
    function forkAt(upto) {
        const src = session;
        const turns = src.turns.slice(0, upto);
        session = store.create({ kind: 'ask', title: i18nFormat('${0} (branch)', src.title), forkedFrom: src.title, turns });
        steps = [];
        paintHead();
        paintBody();
        return session;
    }

    function editQuestion(i) {
        const text = session.turns[i].text;
        forkAt(i);
        input.value = text;
        grow();
        input.focus();
    }

    function regenerate() {
        const turns = session.turns;
        const q = turns[turns.length - 2];
        if (busy || !q || q.role !== 'user') return;
        session = store.update(session.id, { turns: turns.slice(0, -2) });
        input.value = q.text;
        send();
    }

    function answerBlock(t, i) {
        const reads = readsSummary(t.reads || []);
        const acts = msgActions([
            { iconName: 'copy', label: i18n('Copy'), done: i18n('Copied'), disabled: !answerText(t), onClick: () => copyText(answerText(t)) },
            isLast(i) ? { iconName: 'refresh', label: i18n('Answer again'), disabled: busy, onClick: () => regenerate() } : null,
            { iconName: 'fork', label: i18n('Branch from here'), title: i18n('Copy up to this message into a new chat and continue there'), disabled: busy, onClick: () => { forkAt(i + 1); app.toast(i18n('Branched into a new chat; the original is still in Earlier chats')); input.focus(); } },
        ]);
        return h('div', { class: 'wb-msg-ai' },
            reads ? h('div', { class: 'wb-reads' }, icon('eye', { size: 12 }), h('span', { text: i18nFormat('Read ${0}', reads) })) : null,
            t.error ? h('div', { class: 'wb-msg-error', text: t.error }) : renderMarkdown(t.answer),
            t.suggest && WS_NAME[t.suggest] ? h('div', { class: 'wb-ans-acts' },
                button(i18nFormat('Go edit ${0}', WS_NAME[t.suggest]), () => app.go('ai', { ws: t.suggest, draft: t.fixPrompt || '', from: t.answer }), { iconName: 'spark' })) : null,
            t.sent ? h('details', { class: 'wb-sent' },
                h('summary', null, icon('up', { size: 12 }), h('span', { text: i18nFormat('Sent to the AI (about ${0} tokens)', formatTokens(Math.round(t.sent / 1.6))) })),
                h('ul', null,
                    h('li', { text: app.settings().ask.sources.inspector !== false ? i18n('The question and an overview (chat, preset, prompt usage, status of the last 8 requests)') : i18n('The question and an overview (chat, preset, prompt usage)') }),
                    (t.reads || []).map(r => h('li', { text: i18nFormat('${0}${1} (${2} characters)', readsSummary([r]), r.args && Object.keys(r.args).length ? i18nFormat(': ${0}', JSON.stringify(r.args)) : '', r.chars.toLocaleString()) })),
                    app.settings().ask.redact ? h('li', { text: i18n('API keys and endpoint addresses were removed') }) : null)) : null,
            acts);
    }

    function paintOpts() {
        clear(opts);
        const s = app.settings();
        put(opts, checkRow({
            checked: s.ask.previewBeforeSend,
            label: i18n('Show me before sending to the AI'),
            onChange: (v) => { const n = structuredClone(app.settings()); n.ask.previewBeforeSend = v; app.saveSettings(n); },
        }));
        sendBtn.disabled = busy;
        input.disabled = busy;
    }

    async function send() {
        const question = input.value.trim();
        if (!question || busy) return;
        busy = true;
        let controller = null;
        try {
            const s = app.settings();
            let overview;
            const filter = { inspector: s.ask.sources.inspector !== false, redactText: s.ask.redact };
            try { overview = await app.source.askOverview(filter); } catch (err) { overview = finishOverview({ 错误: String(err?.message || err) }, filter); }
            if (s.ask.previewBeforeSend && !globalThis.confirm(i18nFormat('To be sent to the AI:\n\nQuestion: ${0}\n\nOverview:\n${1}\n\nThe AI will then read data as needed. Continue?', question, JSON.stringify(overview, null, 1).slice(0, 1500)))) return;
            // The answer belongs to this session, whichever one is open when it arrives.
            const runId = (session || (session = store.create({ kind: 'ask', title: titleFrom(question) }))).id;
            const started = store.get(runId);
            const saveTo = (patch) => {
                const updated = store.update(runId, patch);
                if (updated && session?.id === runId) session = updated;
                return updated;
            };
            saveTo({ turns: [...started.turns, { role: 'user', text: question, at: Date.now() }] });
            input.value = '';
            grow();
            steps = [];
            controller = new AbortController();
            abort = controller;
            paintBody();
            const history = started.turns.slice(-6).map(t => ({ role: t.role === 'user' ? 'user' : 'assistant', content: t.role === 'user' ? t.text : t.answer || '' }));
            let turn;
            try {
                const result = await runAsk({
                    question,
                    overview,
                    history,
                    sources: s.ask.sources,
                    signal: controller.signal,
                    readers: app.source.askReaders({ redactText: s.ask.redact, suggestions: () => app.suggestions() }),
                    request: (messages, tools) => app.source.aiRequest('ask', { messages, tools, signal: controller.signal }),
                    onStep: (step) => { steps.push(step); paintBody(); },
                });
                turn = { role: 'ai', ...result, at: Date.now() };
            } catch (err) {
                turn = { role: 'ai', answer: '', error: controller.signal.aborted ? i18n('Stopped.') : i18nFormat('Could not ask: ${0}', err?.message || err), reads: steps, at: Date.now() };
            }
            const finished = store.get(runId);
            if (finished) saveTo({ turns: [...finished.turns, turn] });
        } finally {
            busy = false;
            abort = null;
            paintHead();
            paintBody();
        }
    }

    return {
        el,
        flush: true,
        show(o = {}) {
            paintSide();
            paintHead();
            paintBody();
            loadCounts();
            if (o.draft) { input.value = o.draft; grow(); }
            requestAnimationFrame(() => input.focus());
        },
        onSnapshot() { paintSide(); },
        onEscape() {
            if (sideOpen) { sideOpen = false; paintSide(); return true; }
            if (busy) { abort?.abort(); return true; }
            return false;
        },
        destroy() { abort?.abort(); },
    };
}
