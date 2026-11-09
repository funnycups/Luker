// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI iteration: one conversation per (workbench, scope). The AI edits its own copy;
// at the end of each turn the page diffs that copy against the saved one and
// shows a change list. Apply selected writes the accepted units to Luker (through
// the workbench's own save path) and records an undoable history entry.
//
// Scope rules: memory graph / orchestration = global or current character; preset = global only;
// character card = current character only; world book = globally active books or this character's books. A group chat counts as no character.

import { i18n, i18nFormat, listSeparator } from '../i18n.js';
import { h, put, clear, relativeTime, copyText } from '../../lens-shared/util.js';
import { icon } from '../icons.js';
import { button, iconButton, checkRow, segmented, dot, msgActions } from '../ui/components.js';
import { renderMarkdown } from '../ui/markdown.js';
import { changeList } from '../ui/change-list.js';
import { approvalMatches, diffUnits } from '../model/units.js';
import { runIterateTurn, wrapperPrompt, decisionNote, trimMessages } from '../model/iterate.js';
import { groupSessions, titleFrom } from '../model/sessions.js';

const WS = [
    { value: 'memory', label: i18n('Memory graph'), tone: 'memory' },
    { value: 'orch', label: i18n('Orchestration'), tone: 'orch' },
    { value: 'preset', label: i18n('Preset'), tone: 'preset' },
    { value: 'card', label: i18n('Character card'), tone: 'card' },
    { value: 'world', label: i18n('World book'), tone: 'world' },
];
const WS_NAME = Object.fromEntries(WS.map(w => [w.value, w.label]));
const CHIPS = {
    memory: [i18n('Why was something that should be remembered not recalled'), i18n('Create a new memory type'), i18n('What to do about high always-on injection'), i18n('Make the field descriptions clearer')],
    orch: [i18n('What was slow in the last run'), i18n('Can this agent\'s prompt be shorter'), i18n('Make the reviewer stricter'), i18n('Give the slowest agent a faster connection')],
    preset: [i18n('Find contradicting requirements'), i18n('Trim the style entries'), i18n('Replies are too long; what should change'), i18n('This reply is out of character; check the preset')],
    card: [i18n('This reply is not like her; find out why'), i18n('Tighten the description and remove repetition'), i18n('Add some example dialogue'), i18n('Check the world books for conflicts')],
    world: [i18n('Find contradicting or duplicate entries'), i18n('Why did this entry not trigger'), i18n('Add a few keywords'), i18n('Split or trim entries that are too long')],
};
const SCOPE_NOTE = {
    memory: { global: i18n('Edit the memory structure shared by all characters'), character: i18n('Edit only this character\'s own memory structure (created on save if there is none)') },
    orch: { global: i18n('Edit the orchestration profile shared by all characters'), character: i18n('Edit only this character\'s own orchestration profile') },
    preset: { global: i18n('Presets are not per character; this edits the selected preset') },
    card: { character: i18n('Edit this character\'s card and bound world books') },
    world: { global: i18n('Edit globally active world books (affects all chats)'), character: i18n('Edit this character\'s main book, extra books and the books bound to this chat') },
};

export function createIteratePage(app) {
    const store = app.sessions;
    const sess = h('aside', { class: 'wb-sess' });
    const head = h('div', { class: 'wb-chat-head' });
    const body = h('div', { class: 'wb-chat-body' });
    const input = h('textarea', { class: 'wb-input', rows: 1, placeholder: i18n('What should change? Just describe it in your own words'), 'aria-label': i18n('Tell the AI what to change') });
    const sendBtn = button(i18n('Send'), () => send(), { iconName: 'send', className: 'is-primary wb-send' });
    const chips = h('div', { class: 'wb-chips' });
    const opts = h('div', { class: 'wb-composer-opts' });
    const composer = h('div', { class: 'wb-composer' }, chips, h('div', { class: 'wb-input-row' }, input, sendBtn), opts);
    const chat = h('section', { class: 'wb-chat' }, head, body, composer);
    const el = h('div', { class: 'wb-page is-split' }, sess, chat);

    let ws = 'card';
    let scope = 'character';
    let scopes = null; // { memory: { global, character }, ... }
    let session = null;
    // Saved copies per target: { base, target, title } — rebuilt when missing.
    const work = new Map();
    // Pending proposals per session id: { base, ai, target, title, workKey }.
    const drafts = new Map();
    let busy = false;
    let abort = null;
    let liveStep = '';
    let withReply = true;
    let sessOpen = false;
    let loadError = '';

    const iter = () => app.source.iterate;
    const charName = () => app.snapshot()?.card?.name || '';

    // ----- scope ----------------------------------------------------------
    function allowedScopes(w = ws) {
        const s = scopes?.[w] || { global: w !== 'card', character: Boolean(charName()) && w !== 'preset' };
        return { global: Boolean(s.global) && w !== 'card', character: Boolean(s.character) && w !== 'preset' };
    }
    function fixScope() {
        const a = allowedScopes();
        if (scope === 'character' && !a.character) scope = a.global ? 'global' : 'character';
        if (scope === 'global' && !a.global) scope = 'character';
    }
    const disabled = () => Boolean(scopes?.[ws]?.disabled);
    const blocked = () => disabled() || (ws === 'card' && !allowedScopes().character) || (ws === 'world' && !allowedScopes().character && !allowedScopes().global);

    // ----- sessions -------------------------------------------------------
    const sessions = () => store.list('iterate');
    function pendingOf(s) {
        const last = [...(s?.turns || [])].reverse().find(t => t.role === 'ai' && t.changes?.length);
        return last && last.state === 'pending' ? last.changes.length : 0;
    }

    function paintSessions() {
        clear(sess);
        sess.classList.toggle('is-open', sessOpen);
        const list = sessions();
        put(sess,
            h('div', { class: 'wb-sess-head' },
                button(i18n('New conversation'), () => newChat(), { iconName: 'plus' }),
                sessOpen ? iconButton('x', i18n('Off'), () => { sessOpen = false; paintSessions(); }) : null),
            h('div', { class: 'wb-sess-list' },
                list.length ? groupSessions(list).map(g => [
                    h('div', { class: 'wb-src-group', text: g.label }),
                    g.items.map(s => {
                        const p = pendingOf(s);
                        return h('button', { type: 'button', class: 'wb-sess-item', 'aria-current': String(s.id === session?.id), onClick: () => openSession(s.id) },
                            dot(s.ws),
                            h('span', { class: 'wb-sess-main' },
                                h('span', { class: 'wb-sess-t', text: s.title }),
                                h('span', { class: 'wb-sess-m' },
                                    `${WS_NAME[s.ws]} · ${s.scope === 'character' ? s.scopeName || i18n('Character') : i18n('Global')} · ${relativeTime(s.updatedAt)}`,
                                    p ? h('span', { class: 'wb-sess-p', text: i18nFormat(' · ${0} to confirm', p) }) : null)));
                    })]) : h('p', { class: 'wb-note wb-sess-empty', text: i18n('No chats yet.') })));
    }

    function newChat() {
        session = null;
        sessOpen = false;
        paintAll();
        input.focus();
    }

    function openSession(id) {
        const s = store.get(id);
        if (!s) return;
        session = s;
        ws = s.ws;
        scope = s.scope;
        sessOpen = false;
        paintAll();
    }

    // ----- head -----------------------------------------------------------
    function paintHead() {
        clear(head);
        fixScope();
        const a = allowedScopes();
        const name = charName();
        const locked = Boolean(session?.turns?.length);
        put(head,
            iconButton('list', i18n('Chat list'), () => { sessOpen = true; paintSessions(); }, { className: 'wb-src-toggle' }),
            segmented(WS.map(w => ({ ...w, disabled: locked && w.value !== ws })), ws, (v) => { ws = v; session = null; scope = v === 'preset' ? 'global' : 'character'; paintAll(); }, { ariaLabel: i18n('Which workbench to edit'), className: 'wb-ws-seg' }),
            segmented([
                { value: 'global', label: i18n('Global'), iconName: 'globe', hidden: ws === 'card', disabled: !a.global || (locked && scope !== 'global') },
                { value: 'character', label: name ? i18nFormat('Current character "${0}"', name) : i18n('No character card selected'), iconName: 'card', hidden: ws === 'preset', disabled: !a.character || (locked && scope !== 'character') },
            ], scope, (v) => { scope = v; session = null; paintAll(); }, { ariaLabel: i18n('Which copy to edit'), className: 'wb-scope-seg' }),
            h('span', { class: 'wb-scope-note', text: blocked() ? '' : !name && ws !== 'preset' && ws !== 'card' && scope === 'global' ? i18n('No character selected; only global can be edited') : SCOPE_NOTE[ws][scope] || '' }));
    }

    // ----- body -----------------------------------------------------------
    function paintBody() {
        clear(body);
        if (disabled()) {
            put(body, h('div', { class: 'wb-empty' }, icon('card', { size: 28 }), h('b', { text: i18n('This workbench is unavailable') }),
                h('div', { text: i18n('The Luker extension it depends on is disabled. Enable it under Manage Extensions, then reload the page.') })));
            composer.hidden = true;
            return;
        }
        if (blocked()) {
            put(body, h('div', { class: 'wb-empty' }, icon('card', { size: 28 }), h('b', { text: i18n('No character card selected') }),
                h('div', { text: ws === 'world' ? i18n('No globally active world book and no character chat open. Select a global book in the world info panel, or open a character\'s chat (not a group chat).') : i18n('Character cards have no global copy. Open a character\'s chat in Luker first (not a group chat), then come back. Memory graph, orchestration and presets can still be edited globally.') })));
            composer.hidden = true;
            return;
        }
        composer.hidden = false;
        const turns = session?.turns || [];
        if (!turns.length && !busy) {
            const w = work.get(keyOf());
            put(body, h('div', { class: 'wb-empty' }, icon('spark', { size: 28 }),
                h('b', { text: i18nFormat('Edit ${0} with AI', WS_NAME[ws]) }),
                h('div', { text: loadError || (w ? i18nFormat('Editing: ${0}. Say what you do not like. The AI puts its edits in a change list, and you tick what to apply.', w.title) : i18n('Say what you do not like. The AI puts its edits in a change list, and you tick what to apply.')) })));
        }
        if (session?.forkedFrom) put(body, h('div', { class: 'wb-fork-note', text: i18nFormat('Branched from "${0}"', session.forkedFrom) }));
        turns.forEach((t, i) => put(body, t.role === 'user' ? userBlock(t, i) : aiBlock(t, i)));
        if (busy) {
            put(body, h('div', { class: 'wb-msg-ai' },
                h('div', { class: 'wb-reads is-live' }, h('span', { class: 'wb-spinner', 'aria-hidden': 'true' }), h('span', { text: liveStep || i18n('Thinking it over…') })),
                button(i18n('Stop answering'), () => abort?.abort(), { iconName: 'stop', className: 'is-ghost is-sm' })));
        }
        requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
    }

    // ----- message actions ------------------------------------------------
    function userBlock(t, i) {
        return h('div', { class: 'wb-msg-turn' },
            h('div', { class: 'wb-msg-me', text: t.text }),
            msgActions([
                { iconName: 'copy', label: i18n('Copy'), done: i18n('Copied'), onClick: () => copyText(t.text) },
                { iconName: 'edit', label: i18n('Edit and resend'), title: i18n('Edit this message in a new branch; the original chat stays as it is'), disabled: busy, onClick: () => editMessage(i) },
            ]));
    }

    function turnText(t) {
        const lines = [t.error || t.text || ''];
        if (t.changes?.length) lines.push('', i18nFormat('Changes (${0}):', t.target || ''), ...t.changes.map(c => i18nFormat('- ${0} "${1}"', { add: i18n('Added'), remove: i18n('Removed item'), change: i18n('Edited') }[c.kind] || '', c.label)));
        return lines.join('\n').trim();
    }

    /**
     * New session holding turns [0, upto). The model history is rebuilt from
     * the visible text (tool calls are not carried over); pending changes in
     * the copied turns count as discarded, applied ones stay applied.
     */
    function forkAt(upto) {
        const src = session;
        const turns = src.turns.slice(0, upto).map(t => (t.state === 'pending' ? { ...t, state: 'discarded' } : t));
        const messages = turns.flatMap(t => (t.role === 'user'
            ? [{ role: 'user', content: t.text }]
            : (t.text || t.changes?.length ? [{ role: 'assistant', content: turnText(t) }] : [])));
        session = store.create({ kind: 'iterate', ws: src.ws, scope: src.scope, scopeName: src.scopeName, title: i18nFormat('${0} (branch)', src.title), forkedFrom: src.title, turns, messages, targetId: src.targetId,
            note: '（这段对话是从之前的对话分出来的。前面列出的改动，已应用的已经保存进 Luker，其余没有保存；以现在读到的内容为准。）' });
        paintAll();
        return session;
    }

    function editMessage(i) {
        const text = session.turns[i].text;
        forkAt(i);
        input.value = text;
        grow();
        input.focus();
    }

    const canRegen = (t) => !t.changes?.length || t.state === 'pending' || t.state === 'discarded';

    function regenerate() {
        const turns = session.turns;
        const last = turns[turns.length - 1];
        const q = turns[turns.length - 2];
        if (busy || !q || q.role !== 'user' || !canRegen(last)) return;
        drafts.delete(session.id);
        const keep = Number.isInteger(last.msgKeep) ? last.msgKeep : Math.max(0, (session.messages || []).length - 2);
        session = store.update(session.id, { turns: turns.slice(0, -2), messages: (session.messages || []).slice(0, keep) });
        input.value = q.text;
        send();
    }

    function aiBlock(t, index) {
        const reads = t.reads ? `${i18nFormat('Read ${0} times', t.reads)}${t.edits ? i18nFormat(', edited ${0} times', t.edits) : ''}${t.failed ? i18nFormat(', ${0} failed', t.failed) : ''}` : '';
        const owner = session.id;
        const draft = drafts.get(owner);
        // A stored change may be shortened; while its draft exists, show it in full.
        const changes = t.state === 'pending' && draft?.changes ? draft.changes : t.changes;
        const node = h('div', { class: 'wb-msg-ai' },
            reads ? h('div', { class: 'wb-reads' }, icon('eye', { size: 12 }), h('span', { text: reads })) : null,
            t.error ? h('div', { class: 'wb-msg-error', text: t.error }) : t.text ? renderMarkdown(t.text) : null);
        const last = index === session.turns.length - 1;
        const acts = msgActions([
            { iconName: 'copy', label: i18n('Copy'), done: i18n('Copied'), disabled: !turnText(t), onClick: () => copyText(turnText(t)) },
            last ? { iconName: 'refresh', label: i18n('Answer again'), title: canRegen(t) ? i18n('Discard this round and let the AI redo it') : i18n('This round has been applied; undo it first to answer again'), disabled: busy || !canRegen(t), onClick: () => regenerate() } : null,
            { iconName: 'fork', label: i18n('Branch from here'), title: i18n('Copy up to this message into a new chat and continue editing there'), disabled: busy, onClick: () => { forkAt(index + 1); app.toast(i18n('Branched into a new chat; the original is still in the chat list')); input.focus(); } },
        ]);
        if (changes?.length) {
            const card = changeList({
                changes,
                state: t.state || 'pending',
                target: t.target || '',
                note: app.settings().reviewChanges ? '' : i18n('Applied automatically. You can undo it in Change history'),
                onApply: (keys) => apply(owner, index, keys),
                onDiscard: () => discard(owner, index),
                onUndo: t.historyId && app.history.canUndo(t.historyId) ? () => undoTurn(owner, index) : null,
            });
            put(node, card.el);
        }
        put(node, acts);
        return node;
    }

    function paintOpts() {
        clear(chips);
        put(chips, CHIPS[ws].map(c => h('button', { type: 'button', class: 'wb-chip', onClick: () => { input.value = c; grow(); input.focus(); } }, c)));
        clear(opts);
        const s = app.settings();
        put(opts,
            checkRow({ checked: withReply, label: i18n('Include the latest reply'), onChange: (v) => { withReply = v; } }),
            checkRow({ checked: !s.reviewChanges, label: i18n('Apply automatically'), onChange: (v) => { const n = structuredClone(app.settings()); n.reviewChanges = !v; app.saveSettings(n); paintBody(); } }));
        sendBtn.disabled = busy;
        input.disabled = busy;
    }

    function paintAll() {
        paintSessions();
        paintHead();
        paintBody();
        paintOpts();
        ensureWork();
    }

    // ----- working copies -------------------------------------------------
    const keyOf = (w = ws, s = scope) => `${w}:${s}:${s === 'character' ? app.snapshot()?.chat?.character?.avatar || '' : w === 'preset' ? app.snapshot()?.preset?.name || '' : ''}`;
    // What a conversation edits, ignoring details that may change (a card's list position).
    const targetId = ({ scope: s, avatar, mode, presetId, ref }) => JSON.stringify({ s, avatar, mode, presetId, ref });

    async function ensureWork() {
        if (blocked() || !iter()) return null;
        const k = keyOf();
        if (work.has(k)) return work.get(k);
        try {
            const res = await iter().load(ws, scope);
            const w = { base: res.live, target: res.target, title: res.title };
            work.set(k, w);
            loadError = '';
            if (!session?.turns?.length && !busy) paintBody();
            return w;
        } catch (err) {
            loadError = String(err?.message || err);
            paintBody();
            return null;
        }
    }

    // ----- send -----------------------------------------------------------
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

    /** Writes to one session whichever is on screen, and keeps the on-screen copy current. */
    function saveTo(id, patch) {
        const updated = store.update(id, patch);
        if (updated && session?.id === id) session = updated;
        return updated;
    }

    async function send() {
        const text = input.value.trim();
        if (!text || busy || blocked()) return;
        // Everything below belongs to this request, whatever the user opens meanwhile.
        const runWs = ws;
        const runScope = scope;
        const runKey = keyOf();
        let runId = session?.id || null;
        busy = true;
        try {
            let loaded;
            try {
                loaded = await iter().load(runWs, runScope);
            } catch (err) {
                loadError = String(err?.message || err);
                app.toast(loadError || i18n('Could not read what should be edited'), { error: true });
                return;
            }
            loadError = '';
            const w = { base: loaded.live, target: loaded.target, title: loaded.title };
            work.set(runKey, w);
            const id = targetId(w.target);
            let current = runId ? store.get(runId) : null;
            if (current?.targetId && current.targetId !== id) {
                app.toast(i18nFormat('This chat was editing something else (${0}). Start a new conversation to edit the current selection.', current.scopeName || WS_NAME[runWs]), { error: true, duration: 7000 });
                return;
            }
            if (!current) {
                current = store.create({ kind: 'iterate', ws: runWs, scope: runScope, scopeName: runScope === 'character' ? charName() : '', title: titleFrom(text), messages: [], targetId: id });
                runId = current.id;
                session = current;
            } else if (!current.targetId) {
                current = saveTo(runId, { targetId: id });
            }
            // Pending changes from the last turn that were never decided count as discarded.
            const turns = current.turns.map(t => (t.state === 'pending' ? { ...t, state: 'discarded' } : t));
            const draft = { base: structuredClone(w.base), ai: structuredClone(w.base), target: w.target, title: w.title, workKey: runKey, ws: runWs };
            drafts.set(runId, draft);
            let userContent = current.note ? `${current.note}\n\n${text}` : text;
            if (withReply) {
                const reply = await iter().lastReply?.();
                if (reply) userContent += `\n\n<最近一条回复>\n${reply}\n</最近一条回复>`;
            }
            current = saveTo(runId, { turns: [...turns, { role: 'user', text, at: Date.now() }], note: '' });
            input.value = '';
            grow();
            liveStep = '';
            const controller = new AbortController();
            abort = controller;
            paintBody();
            paintOpts();
            const turn = await runTurn({ runId, runWs, runScope, current, draft, userContent, controller });
            current = store.get(runId);
            if (!current) return;
            current = saveTo(runId, { turns: [...current.turns, turn] });
            if (turn.changes?.length && !app.settings().reviewChanges) {
                busy = false;
                await apply(runId, current.turns.length - 1, turn.changes.map(c => c.key));
            }
        } finally {
            busy = false;
            abort = null;
            paintAll();
            app.refreshBadges();
        }
    }

    /** One model request. Never throws: a failure becomes the turn's error text. */
    async function runTurn({ runId, runWs, runScope, current, draft, userContent, controller }) {
        try {
            const system = await iter().systemPrompt(runWs, runScope, draft.ai, { wrapper: wrapperPrompt({ wsName: WS_NAME[runWs], scopeText: draft.title, builtin: app.settings().builtinPrompt }) });
            const history = (current.messages || []).filter(m => m.role !== 'system');
            const messages = trimMessages([{ role: 'system', content: system }, ...history, { role: 'user', content: userContent }]);
            const tools = await iter().tools(runWs, draft.ai);
            const result = await runIterateTurn({
                messages,
                live: draft.ai,
                tools,
                isRead: (n) => iter().isRead(runWs, n),
                runRead: (call, live) => iter().runRead(runWs, call, live),
                runEdit: (call, live) => iter().runEdit(runWs, call, live),
                request: (msgs, t) => app.source.aiRequest(runWs, { messages: msgs, tools: t, signal: controller.signal }),
                onRound: (info) => { liveStep = i18nFormat('Read ${0} times, edited ${1} times…', info.reads, info.edits); paintBody(); },
                signal: controller.signal,
            });
            draft.ai = result.live;
            const changes = diffUnits(iter().units(runWs, draft.base), iter().units(runWs, draft.ai));
            draft.changes = changes;
            if (!changes.length) drafts.delete(runId);
            const all = result.messages.filter(m => m.role !== 'system');
            // Where this turn's messages start in the stored (last 60) list — Answer again cuts back to it.
            const prior = messages.filter(m => m.role !== 'system').length - 1;
            const msgKeep = Math.max(0, prior - Math.max(0, all.length - 60));
            saveTo(runId, { messages: all.slice(-60) });
            return { role: 'ai', text: result.text || (changes.length ? '' : i18n('(The AI made no changes)')), reads: result.reads.length, edits: result.edits.length, failed: result.failed.length, changes, state: changes.length ? 'pending' : '', target: draft.title, msgKeep, at: Date.now() };
        } catch (err) {
            drafts.delete(runId);
            return { role: 'ai', text: '', error: controller.signal.aborted ? i18n('Stopped.') : i18nFormat('Not changed: ${0}', err?.message || err), msgKeep: (store.get(runId)?.messages || []).length, at: Date.now() };
        }
    }

    // ----- decide ---------------------------------------------------------
    const applying = new Set();

    async function apply(id, index, keys) {
        const owner = store.get(id);
        const t = owner?.turns[index];
        if (!t?.changes || applying.has(id)) return;
        const draft = drafts.get(id);
        const sessionWs = owner.ws;
        if (!draft || !approvalMatches(t.changes, diffUnits(iter().units(sessionWs, draft.base), iter().units(sessionWs, draft.ai)), keys)) {
            app.toast(i18n('This draft is no longer available. Ask the AI again.'), { error: true, duration: 7000 });
            return;
        }
        applying.add(id);
        try {
            const next = iter().rebuild(sessionWs, draft.base, draft.ai, keys);
            const handle = await iter().commit(sessionWs, draft.target, draft.base, next, keys);
            const saved = new Set(handle.applied ?? keys);
            const skipped = handle.skipped ?? [];
            const failure = handle.failure ?? '';
            const labelOf = (key) => t.changes.find(c => c.key === key)?.label ?? key;
            const unsaved = skipped.map(s => labelOf(s.key));
            const labels = t.changes.filter(c => saved.has(c.key)).map(c => c.label);
            const dropped = t.changes.filter(c => !keys.includes(c.key)).map(c => c.label);
            const { workKey } = draft;
            const historyId = app.history.record({
                ws: sessionWs, title: `${owner.title}`, scope: draft.title,
                lines: t.changes.filter(c => saved.has(c.key)).map(c => i18nFormat('${0} "${1}"', { add: i18n('Added'), remove: i18n('Removed item'), change: i18n('Edited') }[c.kind], c.label)),
                from: i18n('AI chat'),
                undo: async () => { await handle.undo(); work.delete(workKey); },
            });
            // What is stored now may differ from the draft, so it is reloaded next time.
            work.delete(workKey);
            drafts.delete(id);
            const fresh = store.get(id);
            if (fresh) saveTo(id, { turns: fresh.turns.map((x, i) => (i === index ? { ...x, state: dropped.length || unsaved.length ? 'partial' : 'applied', historyId } : x)), note: decisionNote({ applied: labels, discarded: dropped, unsaved }) });
            if (unsaved.length) app.toast([i18nFormat('Saved ${0}; not saved: ${1}', saved.size, unsaved.join(listSeparator())), failure].filter(Boolean).join(' · '), { error: true, duration: 7000, action: i18n('Undo'), onAction: () => undoTurn(id, index) });
            else app.toast(i18nFormat('Applied ${0}', saved.size), { action: i18n('Undo'), onAction: () => undoTurn(id, index) });
            app.reload();
        } catch (err) {
            app.toast(i18nFormat('Not saved: ${0}', err?.message || err), { error: true, duration: 7000 });
        } finally {
            applying.delete(id);
        }
        paintAll();
        app.refreshBadges();
    }

    function discard(id, index) {
        const owner = store.get(id);
        if (!owner) return;
        const t = owner.turns[index];
        drafts.delete(id);
        const turns = owner.turns.map((x, i) => (i === index ? { ...x, state: 'discarded' } : x));
        saveTo(id, { turns, note: decisionNote({ discarded: (t?.changes || []).map(c => c.label) }) });
        paintAll();
        app.refreshBadges();
    }

    async function undoTurn(id, index) {
        const t = store.get(id)?.turns[index];
        if (!t?.historyId) return;
        try {
            await app.history.undo(t.historyId);
            const fresh = store.get(id);
            if (fresh) saveTo(id, { turns: fresh.turns.map((x, i) => (i === index ? { ...x, state: 'discarded' } : x)), note: `（用户撤销了上一轮应用的改动：${t.changes.map(c => c.label).join(listSeparator())}。现在是改之前的样子。）` });
            app.toast(i18n('Undone'));
            app.reload();
        } catch (err) {
            app.toast(i18nFormat('Could not undo: ${0}', err?.message || err), { error: true });
        }
        paintAll();
        app.refreshBadges();
    }

    // ----- refresh when Luker changes -------------------------------------
    async function refreshScopes() {
        try { scopes = await iter()?.scopes?.(); } catch { scopes = null; }
    }

    return {
        el,
        flush: true,
        async show(o = {}) {
            if (o.sessionId) {
                const s = store.get(o.sessionId);
                if (s) { session = s; ws = s.ws; scope = s.scope; }
            } else if (o.ws && o.ws !== ws) {
                ws = o.ws;
                session = null;
                scope = ws === 'preset' ? 'global' : 'character';
            } else if (o.ws) {
                session = null;
            }
            await refreshScopes();
            paintAll();
            if (o.draft) { input.value = o.draft; grow(); }
            requestAnimationFrame(() => input.focus());
        },
        onSnapshot() {
            // The open character may have changed: drop copies for other characters.
            for (const k of [...work.keys()]) if (!k.endsWith(`:${app.snapshot()?.chat?.character?.avatar || ''}`) && k.includes(':character:')) work.delete(k);
            refreshScopes().then(() => { if (el.isConnected && !busy) { paintHead(); paintBody(); } });
        },
        pendingCount: () => sessions().reduce((n, s) => n + (pendingOf(s) ? 1 : 0), 0),
        pendingInfo() {
            const s = sessions().find(x => x.ws === 'card' && pendingOf(x));
            return s ? { pending: pendingOf(s), sessionTitle: s.title, sessionId: s.id } : null;
        },
        onEscape() {
            if (sessOpen) { sessOpen = false; paintSessions(); return true; }
            if (busy) { abort?.abort(); return true; }
            return false;
        },
        destroy() { abort?.abort(); },
    };
}
