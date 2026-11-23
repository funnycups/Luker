// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI iteration: one conversation per (target, scope). The AI edits its own copy
// and/or stages ProposalBus actions; at the end of each turn the page diffs
// against the saved copy and shows a unified change list. Apply selected writes
// accepted units and proposals through the target's commit path + ProposalBus,
// recording an undoable history entry.
//
// In-flight runs are isolated by runId / sessionId, and target/scope/session
// switches increment selectionVersion so async completions never bleed across
// views or hijack active sessions.

import { i18n, i18nFormat, listSeparator } from '../i18n.js';
import { h, put, clear, relativeTime, copyText } from '../../lens-shared/util.js';
import { icon } from '../icons.js';
import { button, iconButton, checkRow, segmented, dot, msgActions } from '../ui/components.js';
import { renderMarkdown } from '../ui/markdown.js';
import { changeList } from '../ui/change-list.js';
import { approvalMatches } from '../model/units.js';
import {
    runIterateTurn,
    createIterateBus,
    buildTurnChanges,
    commitTurnBatch,
    wrapperPrompt,
    decisionNote,
    trimMessages,
} from '../model/iterate.js';
import { groupSessions, titleFrom } from '../model/sessions.js';
import { importLegacySessionsOnce } from '../model/legacy-import.js';
import { isReplayableIterationMessage } from '../../iteration-library/iter-message-filter.js';

const DEFAULT_CHIPS = {
    memory: () => [
        i18n('Why was something that should be remembered not recalled'),
        i18n('Create a new memory type'),
        i18n('What to do about high always-on injection'),
        i18n('Make the field descriptions clearer'),
    ],
    orch: () => [
        i18n('What was slow in the last run'),
        i18n('Can this agent\'s prompt be shorter'),
        i18n('Make the reviewer stricter'),
        i18n('Give the slowest agent a faster connection'),
    ],
    preset: () => [
        i18n('Find contradicting requirements'),
        i18n('Trim the style entries'),
        i18n('Replies are too long — what should change'),
        i18n('This reply is out of character — check the preset'),
    ],
    card: () => [
        i18n('This reply is not like her — find out why'),
        i18n('Tighten the description and remove repetition'),
        i18n('Add some example dialogue'),
        i18n('Check the world books for conflicts'),
    ],
    world: () => [
        i18n('Find contradicting or duplicate entries'),
        i18n('Why did this entry not trigger'),
        i18n('Add a few keywords'),
        i18n('Split or trim entries that are too long'),
    ],
};

const DEFAULT_SCOPE_NOTE = {
    memory: {
        global: () => i18n('Edit the memory structure shared by all characters'),
        character: () => i18n('Edit only this character\'s own memory structure (created on save if there is none)'),
    },
    orch: {
        global: () => i18n('Edit the orchestration profile shared by all characters'),
        character: () => i18n('Edit only this character\'s own orchestration profile'),
    },
    preset: {
        global: () => i18n('Presets are not per character — this edits the selected preset'),
        preset: () => i18n('Presets are not per character — this edits the selected preset'),
    },
    card: {
        character: () => i18n('Edit this character\'s card and bound world books'),
    },
    world: {
        global: () => i18n('Edit globally active world books (affects all chats)'),
        character: () => i18n('Edit this character\'s main book, extra books and the books bound to this chat'),
    },
};

const SCOPE_ORDER = ['character', 'preset', 'chat', 'global'];

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

export function createIteratePage(app) {
    const store = app.sessions;
    const sess = h('aside', { class: 'wb-sess' });
    const head = h('div', { class: 'wb-chat-head' });
    const controlsSlot = h('div', { class: 'wb-iter-controls', hidden: true });
    const body = h('div', { class: 'wb-chat-body' });
    const input = h('textarea', {
        class: 'wb-input',
        rows: 1,
        placeholder: i18n('What should change? Just describe it in your own words'),
        'aria-label': i18n('Tell the AI what to change'),
    });
    const sendBtn = button(i18n('Send'), () => send(), { iconName: 'send', className: 'is-primary wb-send' });
    const chips = h('div', { class: 'wb-chips' });
    const opts = h('div', { class: 'wb-composer-opts' });
    const composer = h('div', { class: 'wb-composer' }, chips, h('div', { class: 'wb-input-row' }, input, sendBtn), opts);
    const chat = h('section', { class: 'wb-chat' }, head, body, composer);
    const previewPane = h('aside', { class: 'wb-iter-preview', hidden: true });
    const el = h('div', { class: 'wb-page is-split' }, sess, chat, previewPane);

    let ws = '';
    let scope = 'character';
    let userPickedScope = false;
    let scopesByTarget = {};
    let session = null;
    let recentSessions = [];
    const sessionScopes = new Map();
    let selectionVersion = 0;
    let pendingNewSelection = -1;
    let refreshVersion = 0;
    let snapshotVersion = 0;
    let workLoadVersion = 0;
    let activeScopeKey = '';
    const activeRuns = new Map();
    const applying = new Set();
    const importedScopeTargets = new Set();

    // Saved copies per target+scope key: { base, target, title }
    const work = new Map();
    // Pending drafts per session id: { base, ai, target, title, workKey, ws, bus, changes, proposalIds }
    const drafts = new Map();

    let withReply = true;
    let sessOpen = false;
    let loadError = '';
    let pendingCancelHook = null;
    let pendingLaunch = null;

    async function firePendingCancelHook() {
        const hook = pendingCancelHook;
        pendingCancelHook = null;
        if (!hook || hook.applied || typeof hook.fn !== 'function') return;
        try {
            await hook.fn();
        } catch (err) {
            console.warn('[workbench/iterate] onCancelWithoutApply failed:', err);
        }
    }

    const getCtx = () => globalThis.Luker?.getContext?.() ?? globalThis.lukerContext ?? null;
    const getTargets = () => app.iterateTargets?.() || [];
    const targetById = (id) => (id ? getTargets().find(t => t.id === id) || null : null);
    const selectDefaultTarget = () => targetById(ws) || getTargets()[0] || null;
    const targetLabel = (t) => (typeof t?.label === 'function' ? t.label() : String(t?.label || t?.id || ''));
    const targetName = (id = ws) => {
        const t = targetById(id);
        return t ? targetLabel(t) : String(id || '');
    };
    const charName = () => app.snapshot()?.card?.name || app.snapshot()?.chat?.character?.name || '';
    const charAvatar = () => {
        const snap = app.snapshot();
        const ctx = getCtx();
        return String(snap?.chat?.character?.avatar || snap?.card?.avatar || ctx?.characters?.[ctx?.characterId]?.avatar || '').trim();
    };
    const presetRef = () => {
        const snap = app.snapshot();
        const ctx = getCtx();
        if (snap?.preset?.ref?.name) return snap.preset.ref;
        const selected = ctx?.presets?.getSelected?.('openai');
        if (selected?.name) return selected;
        return snap?.preset?.name ? { collection: 'openai', name: snap.preset.name } : null;
    };
    const presetName = () => String(presetRef()?.name || '');
    const chatTarget = () => {
        const snap = app.snapshot();
        const ctx = getCtx();
        return snap?.chat?.target || ctx?.resolveChatStateTarget?.() || null;
    };
    const chatLabel = () => String(app.snapshot()?.chat?.label || '');
    const hasChatScope = () => Boolean(chatTarget() || app.snapshot()?.chat?.chatId || getCtx()?.getCurrentChatId?.());

    // ----- scope helpers --------------------------------------------------
    function rawScopesFor(w = ws) {
        const cached = scopesByTarget?.[w];
        if (cached && typeof cached === 'object') return cached;
        return { global: w !== 'card', character: Boolean(charName()) && w !== 'preset' };
    }

    function allowedScopes(w = ws) {
        const s = rawScopesFor(w);
        return {
            global: Boolean(s.global),
            character: Boolean(s.character),
            preset: Boolean(s.preset),
            chat: Boolean(s.chat),
        };
    }

    function scopeSupported(sKey, w = ws) {
        const s = rawScopesFor(w);
        return Object.hasOwn(s, sKey) && s[sKey] !== undefined;
    }

    function fixScope() {
        const a = allowedScopes();
        if (userPickedScope && a[scope]) return;
        userPickedScope = false;
        for (const candidate of SCOPE_ORDER) {
            if (a[candidate]) {
                scope = candidate;
                return;
            }
        }
        for (const candidate of SCOPE_ORDER) {
            if (scopeSupported(candidate)) {
                scope = candidate;
                return;
            }
        }
    }

    function scopeOptsFor(s = scope) {
        if (s === 'character') {
            const avatar = charAvatar();
            return avatar ? { scope: 'character', avatar } : null;
        }
        if (s === 'preset') {
            const ref = presetRef();
            return ref ? { scope: 'preset', target: clone(ref) } : null;
        }
        if (s === 'chat') {
            const ct = chatTarget();
            if (ct) return { scope: 'chat', target: clone(ct) };
            return hasChatScope() ? { scope: 'chat' } : null;
        }
        return { scope: 'global' };
    }

    function scopeDisplayName(s = scope) {
        if (s === 'character') return charName() || i18n('Character');
        if (s === 'preset') return presetName() || i18n('Preset');
        if (s === 'chat') return chatLabel() || i18n('This chat');
        return i18n('Global');
    }

    function scopeNoteText(t, s = scope) {
        if (!t) return '';
        if (typeof t.scopeNotes === 'function') return String(t.scopeNotes(s, getCtx()) || '');
        if (t.scopeNotes && typeof t.scopeNotes === 'object' && t.scopeNotes[s]) {
            const v = t.scopeNotes[s];
            return typeof v === 'function' ? String(v() || '') : String(v || '');
        }
        const fallback = DEFAULT_SCOPE_NOTE[t.id]?.[s];
        return typeof fallback === 'function' ? fallback() : '';
    }

    const disabled = () => {
        const t = selectDefaultTarget();
        if (!t) return true;
        if (typeof t.isEnabled === 'function') {
            try { if (!t.isEnabled(getCtx())) return true; } catch { return true; }
        }
        return Boolean(scopesByTarget?.[ws]?.disabled);
    };

    const blocked = () => {
        if (disabled()) return true;
        const a = allowedScopes();
        return !a[scope] || !scopeOptsFor(scope);
    };

    // ----- active run helpers ---------------------------------------------
    function activeRunForSession(sessionId) {
        if (!sessionId) return null;
        for (const run of activeRuns.values()) {
            if (run.sessionId === sessionId) return run;
        }
        return null;
    }

    const currentRun = () => (session?.id ? activeRunForSession(session.id) : null);
    const currentBusy = () => Boolean(currentRun() || (!session && pendingNewSelection === selectionVersion));

    // ----- sessions -------------------------------------------------------
    function pendingOf(s) {
        const last = [...(s?.turns || [])].reverse().find(t => t.role === 'ai' && t.changes?.length);
        return last && last.state === 'pending' ? last.changes.length : 0;
    }

    function currentScopeKey(w = ws, s = scope) {
        const optsObj = scopeOptsFor(s);
        return `${w}:${s}:${JSON.stringify(optsObj || {})}`;
    }

    async function refreshSessions() {
        const ver = ++refreshVersion;
        const t = selectDefaultTarget();
        const sOpts = scopeOptsFor();
        if (!store || !t || !sOpts) {
            recentSessions = [];
            paintSessions();
            return;
        }

        const importKey = currentScopeKey(t.id, scope);
        if (!importedScopeTargets.has(importKey)) {
            importedScopeTargets.add(importKey);
            const ctx = getCtx();
            if (ctx) {
                try {
                    await importLegacySessionsOnce({
                        ctx,
                        targetId: t.id,
                        scope,
                        scopeOpts: sOpts,
                        scopeName: scopeDisplayName(scope),
                    });
                } catch (err) {
                    console.warn('[workbench/iterate] legacy import failed:', err);
                }
            }
        }

        try {
            const list = await store.list('iterate', sOpts);
            if (ver !== refreshVersion) return;
            for (const s of list) sessionScopes.set(s.id, clone(sOpts));
            recentSessions = list;
            paintSessions();
            app.refreshBadges?.();
        } catch (err) {
            if (ver === refreshVersion) {
                recentSessions = [];
                paintSessions();
                app.toast(String(err?.message || err), { error: true });
            }
        }
    }

    function paintSessions() {
        clear(sess);
        sess.classList.toggle('is-open', sessOpen);
        const list = recentSessions.filter(s => !ws || s.ws === ws);
        put(sess,
            h('div', { class: 'wb-sess-head' },
                button(i18n('New conversation'), () => newChat(), { iconName: 'plus' }),
                sessOpen ? iconButton('x', i18n('Off'), () => { sessOpen = false; paintSessions(); }) : null),
            h('div', { class: 'wb-sess-list' },
                list.length ? groupSessions(list).map(g => [
                    h('div', { class: 'wb-src-group', text: g.label }),
                    g.items.map(s => {
                        const p = pendingOf(s);
                        return h('button', {
                            type: 'button',
                            class: 'wb-sess-item',
                            'aria-current': String(s.id === session?.id),
                            onClick: () => openSession(s.id),
                        },
                        dot(s.ws || 'other'),
                        h('span', { class: 'wb-sess-main' },
                            h('span', { class: 'wb-sess-t', text: s.title }),
                            h('span', { class: 'wb-sess-m' },
                                `${targetName(s.ws)} · ${s.scopeName || scopeDisplayName(s.scope)} · ${relativeTime(s.updatedAt)}`,
                                p ? h('span', { class: 'wb-sess-p', text: i18nFormat(' · ${0} to confirm', p) }) : null)));
                    }),
                ]) : h('p', { class: 'wb-note wb-sess-empty', text: i18n('No chats yet.') })));
    }

    function newChat() {
        void firePendingCancelHook();
        selectionVersion++;
        session = null;
        sessOpen = false;
        paintAll();
        input.focus({ preventScroll: true });
    }

    async function openSession(id) {
        void firePendingCancelHook();
        const version = ++selectionVersion;
        const sOpts = sessionScopes.get(id) || scopeOptsFor() || { scope: 'global' };
        let loaded = recentSessions.find(x => x.id === id) || null;
        if (store) {
            try {
                const fetched = await store.get(id, sOpts);
                if (version !== selectionVersion) return;
                if (fetched) loaded = fetched;
            } catch (err) {
                if (version === selectionVersion) app.toast(String(err?.message || err), { error: true });
                return;
            }
        }
        if (!loaded || version !== selectionVersion) return;
        session = loaded;
        if (loaded.ws && targetById(loaded.ws)) ws = loaded.ws;
        if (loaded.scope) {
            scope = loaded.scope;
            userPickedScope = true;
        }
        sessOpen = false;
        paintAll();
    }

    // ----- header, controls, preview -------------------------------------
    function paintControls() {
        clear(controlsSlot);
        const t = selectDefaultTarget();
        const launch = pendingLaunch;
        pendingLaunch = null;
        if (launch && t && typeof t.applyLaunch === 'function') {
            try {
                t.applyLaunch(launch);
            } catch (err) {
                console.warn('[workbench/iterate] applyLaunch failed:', err);
            }
        }
        if (!t || typeof t.renderControls !== 'function' || blocked() || disabled()) {
            controlsSlot.hidden = true;
            return;
        }
        const currentDraft = session?.id ? drafts.get(session.id) : null;
        const w = work.get(keyOf());
        const live = currentDraft?.ai ?? w?.base ?? null;
        try {
            const node = t.renderControls({
                live,
                scope,
                settings: app.settings(),
                onReload: () => reloadCurrentWork(),
            });
            if (node instanceof Node) {
                put(controlsSlot, node);
                controlsSlot.hidden = false;
            } else {
                controlsSlot.hidden = true;
            }
        } catch (err) {
            console.warn('[workbench/iterate] renderControls failed:', err);
            controlsSlot.hidden = true;
        }
    }

    function paintPreview() {
        clear(previewPane);
        const t = selectDefaultTarget();
        if (app.isCompact?.() || !t || typeof t.renderPreview !== 'function' || blocked() || disabled()) {
            previewPane.hidden = true;
            return;
        }
        const currentDraft = session?.id ? drafts.get(session.id) : null;
        const w = work.get(keyOf());
        const base = currentDraft?.base ?? w?.base ?? null;
        const ai = currentDraft?.ai ?? w?.base ?? null;
        const target = currentDraft?.target ?? w?.target ?? null;
        try {
            const node = t.renderPreview({ base, ai, target });
            if (node instanceof Node) {
                put(previewPane, node);
                previewPane.hidden = false;
            } else {
                previewPane.hidden = true;
            }
        } catch (err) {
            console.warn('[workbench/iterate] renderPreview failed:', err);
            previewPane.hidden = true;
        }
    }

    function paintHead() {
        clear(head);
        const targets = getTargets();
        if (!targets.length) {
            put(head,
                iconButton('list', i18n('Chat list'), () => { sessOpen = true; paintSessions(); }, { className: 'wb-src-toggle' }),
                h('span', { class: 'wb-chat-title', text: i18n('AI iteration') }));
            controlsSlot.hidden = true;
            return;
        }
        if (!targets.some(t => t.id === ws)) ws = targets[0].id;
        fixScope();
        const t = selectDefaultTarget();
        const a = allowedScopes();
        const locked = Boolean(session?.turns?.length);
        const name = charName();
        const pName = presetName();
        const cLabel = chatLabel();

        const scopeOptions = [
            {
                value: 'global',
                label: i18n('Global'),
                iconName: 'globe',
                hidden: !scopeSupported('global'),
                disabled: !a.global || (locked && scope !== 'global'),
            },
            {
                value: 'character',
                label: name ? i18nFormat('Current character "${0}"', name) : i18n('No character card selected'),
                iconName: 'card',
                hidden: !scopeSupported('character'),
                disabled: !a.character || (locked && scope !== 'character'),
            },
            {
                value: 'preset',
                label: pName ? i18nFormat('Current preset "${0}"', pName) : i18n('No preset selected'),
                iconName: 'preset',
                hidden: !scopeSupported('preset'),
                disabled: !a.preset || (locked && scope !== 'preset'),
            },
            {
                value: 'chat',
                label: cLabel ? i18nFormat('Current chat "${0}"', cLabel) : i18n('No chat open'),
                iconName: 'ask',
                hidden: !scopeSupported('chat'),
                disabled: !a.chat || (locked && scope !== 'chat'),
            },
        ];

        put(head,
            iconButton('list', i18n('Chat list'), () => { sessOpen = true; paintSessions(); }, { className: 'wb-src-toggle' }),
            segmented(
                targets.map(item => ({
                    value: item.id,
                    label: targetLabel(item),
                    tone: item.tone || item.id,
                    disabled: locked && item.id !== ws,
                })),
                ws,
                (v) => {
                    void firePendingCancelHook();
                    selectionVersion++;
                    ws = v;
                    userPickedScope = false;
                    session = null;
                    fixScope();
                    activeScopeKey = currentScopeKey();
                    paintAll();
                    void refreshSessions();
                },
                { ariaLabel: i18n('Which workbench to edit'), className: 'wb-ws-seg' },
            ),
            scopeOptions.some(o => !o.hidden) ? segmented(
                scopeOptions,
                scope,
                (v) => {
                    void firePendingCancelHook();
                    selectionVersion++;
                    scope = v;
                    userPickedScope = true;
                    session = null;
                    activeScopeKey = currentScopeKey();
                    paintAll();
                    void refreshSessions();
                },
                { ariaLabel: i18n('Which copy to edit'), className: 'wb-scope-seg' },
            ) : null,
            controlsSlot,
            h('span', { class: 'wb-scope-note', text: blocked() ? '' : scopeNoteText(t, scope) }));

        paintControls();
        if (app.isCompact?.()) {
            globalThis.requestAnimationFrame?.(() => {
                try {
                    head.querySelector('.wb-ws-seg [aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
                } catch { /* ignore in test DOM */ }
            });
        }
    }

    // ----- body -----------------------------------------------------------
    function paintBody() {
        clear(body);
        const t = selectDefaultTarget();
        const busy = currentBusy();
        const run = currentRun();

        if (!t) {
            put(body, h('div', { class: 'wb-empty' },
                icon('spark', { size: 28 }),
                h('b', { text: i18n('AI iteration') }),
                h('div', { text: i18n('No iteration targets are registered yet.') })));
            composer.hidden = true;
            return;
        }
        if (disabled()) {
            put(body, h('div', { class: 'wb-empty' },
                icon('card', { size: 28 }),
                h('b', { text: i18n('This workbench is unavailable') }),
                h('div', { text: i18n('The Luker extension it depends on is disabled. Enable it under Manage Extensions, then reload the page.') })));
            composer.hidden = true;
            return;
        }
        if (blocked()) {
            put(body, h('div', { class: 'wb-empty' },
                icon('card', { size: 28 }),
                h('b', { text: i18n('Nothing selected to edit') }),
                h('div', {
                    text: ws === 'world'
                        ? i18n('No globally active world book and no character chat open. Select a global book in the world info panel, or open a character\'s chat (not a group chat).')
                        : scope === 'preset'
                            ? i18n('Select a chat completion preset in Luker first, then come back.')
                            : scope === 'chat'
                                ? i18n('Open a chat in Luker first, then come back.')
                                : i18n('Open a character\'s chat in Luker first (not a group chat), or switch to an available scope.'),
                })));
            composer.hidden = true;
            return;
        }

        composer.hidden = false;
        const turns = session?.turns || [];
        if (!turns.length && !busy) {
            const w = work.get(keyOf());
            put(body, h('div', { class: 'wb-empty' },
                icon('spark', { size: 28 }),
                h('b', { text: i18nFormat('Edit ${0} with AI', targetName()) }),
                h('div', {
                    text: loadError || (w
                        ? i18nFormat('Editing: ${0}. Say what you do not like. The AI puts its edits in a change list, and you tick what to apply.', w.title)
                        : i18n('Say what you do not like. The AI puts its edits in a change list, and you tick what to apply.')),
                })));
        }
        if (session?.forkedFrom) {
            put(body, h('div', { class: 'wb-fork-note', text: i18nFormat('Branched from "${0}"', session.forkedFrom) }));
        }
        turns.forEach((turn, i) => {
            if (turn.role === 'user' && turn.hidden) return;
            put(body, turn.role === 'user' ? userBlock(turn, i, busy) : aiBlock(turn, i, busy));
        });
        if (busy) {
            put(body, h('div', { class: 'wb-msg-ai' },
                h('div', { class: 'wb-reads is-live' },
                    h('span', { class: 'wb-spinner', 'aria-hidden': 'true' }),
                    h('span', { text: run?.liveStep || i18n('Thinking it over…') })),
                run ? button(i18n('Stop answering'), () => run.abort?.abort(), { iconName: 'stop', className: 'is-ghost is-sm' }) : null));
        }
        requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
    }

    // ----- message actions ------------------------------------------------
    function userBlock(turn, i, busy) {
        return h('div', { class: 'wb-msg-turn' },
            h('div', { class: 'wb-msg-me', text: turn.text }),
            msgActions([
                { iconName: 'copy', label: i18n('Copy'), done: i18n('Copied'), onClick: () => copyText(turn.text) },
                {
                    iconName: 'edit',
                    label: i18n('Edit and resend'),
                    title: i18n('Edit this message in a new branch — the original chat stays as it is'),
                    disabled: busy,
                    onClick: () => editMessage(i),
                },
            ]));
    }

    function turnText(turn) {
        const lines = [turn.error || turn.text || ''];
        if (turn.changes?.length) {
            lines.push(
                '',
                i18nFormat('Changes (${0}):', turn.target || ''),
                ...turn.changes.map(c => i18nFormat('- ${0} "${1}"', { add: i18n('Added'), remove: i18n('Removed item'), change: i18n('Edited') }[c.kind] || '', c.label)),
            );
        }
        return lines.join('\n').trim();
    }

    async function forkAt(upto) {
        if (!store || !session) return null;
        const src = session;
        const sOpts = sessionScopes.get(src.id) || scopeOptsFor(src.scope) || { scope: 'global' };
        const turns = src.turns.slice(0, upto).map(t => (t.state === 'pending' ? { ...t, state: 'discarded' } : t));
        const messages = turns.flatMap(t => (t.role === 'user'
            ? [{ role: 'user', content: t.text }]
            : (t.text || t.changes?.length ? [{ role: 'assistant', content: turnText(t) }] : [])));
        try {
            const created = await store.create({
                kind: 'iterate',
                ws: src.ws,
                scope: src.scope,
                scopeName: src.scopeName,
                title: i18nFormat('${0} (branch)', src.title),
                forkedFrom: src.title,
                turns,
                messages,
                targetId: src.targetId,
                note: '（这段对话是从之前的对话分出来的。前面列出的改动，已应用的已经保存进 Luker，其余没有保存；以现在读到的内容为准。）',
            }, sOpts);
            sessionScopes.set(created.id, clone(sOpts));
            selectionVersion++;
            session = created;
            await refreshSessions();
            paintAll();
            return created;
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
            return null;
        }
    }

    async function editMessage(i) {
        if (!session) return;
        const text = session.turns[i].text;
        const created = await forkAt(i);
        if (!created) return;
        input.value = text;
        grow();
        input.focus({ preventScroll: true });
    }

    const canRegen = (t) => !t.changes?.length || t.state === 'pending' || t.state === 'discarded';

    async function regenerate() {
        if (!session || !store) return;
        const version = selectionVersion;
        const targetSessionId = session.id;
        const turns = session.turns;
        const last = turns[turns.length - 1];
        const q = turns[turns.length - 2];
        if (currentBusy() || !q || q.role !== 'user' || !canRegen(last)) return;
        const sOpts = sessionScopes.get(targetSessionId) || scopeOptsFor(session.scope) || { scope: 'global' };
        drafts.delete(targetSessionId);
        const keep = Number.isInteger(last.msgKeep) ? last.msgKeep : Math.max(0, (session.messages || []).length - 2);
        try {
            const updated = await store.update(targetSessionId, {
                turns: turns.slice(0, -2),
                messages: (session.messages || []).slice(0, keep),
            }, sOpts);
            if (version !== selectionVersion || session?.id !== targetSessionId) return;
            if (updated) session = updated;
            if (q.hidden) {
                await send({ promptText: q.text, hideFromUi: true });
            } else {
                input.value = q.text;
                await send();
            }
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
        }
    }

    function formatTracePayload(value) {
        if (value === undefined) return '';
        if (typeof value === 'string') return value;
        try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    }

    function toolTraceBlock(toolCalls) {
        if (!Array.isArray(toolCalls) || !toolCalls.length) return null;
        return h('details', { class: 'wb-sent wb-tool-trace' },
            h('summary', null, icon('list', { size: 12 }), h('span', { text: i18nFormat('Tool calls (${0})', toolCalls.length) })),
            h('div', { class: 'wb-tool-trace-list' }, toolCalls.map((tc) => {
                const name = String(tc?.name || tc?.function?.name || 'tool');
                const rawArgs = tc?.args !== undefined ? tc.args : tc?.function?.arguments;
                const argsText = formatTracePayload(rawArgs ?? {});
                const hasError = tc?.error !== undefined && tc?.error !== null && tc?.error !== '';
                const hasResult = tc?.result !== undefined;
                return h('div', { class: 'wb-tool-entry' },
                    h('div', { class: 'wb-tool-name', text: name }),
                    h('div', { class: 'wb-tool-sec-label', text: i18n('Arguments') }),
                    h('pre', { class: 'wb-prompt-text', text: argsText }),
                    hasError ? h('div', { class: 'wb-tool-sec-label is-error', text: i18n('Error') }) : null,
                    hasError ? h('pre', { class: 'wb-prompt-text is-error', text: String(tc.error) }) : null,
                    !hasError && hasResult ? h('div', { class: 'wb-tool-sec-label', text: i18n('Result') }) : null,
                    !hasError && hasResult ? h('pre', { class: 'wb-prompt-text', text: formatTracePayload(tc.result) }) : null);
            })));
    }

    function aiBlock(turn, index, busy) {
        let reads = '';
        if (turn.reads) {
            reads = `${i18nFormat('Read ${0} times', turn.reads)}${turn.edits ? i18nFormat(', edited ${0} times', turn.edits) : ''}${turn.failed ? i18nFormat(', ${0} failed', turn.failed) : ''}`;
        } else if (turn.edits || turn.failed) {
            reads = [
                turn.edits ? i18nFormat('Edited ${0} times', turn.edits) : '',
                turn.failed ? i18nFormat('${0} edits failed', turn.failed) : '',
            ].filter(Boolean).join(listSeparator());
        }
        const owner = session.id;
        const draft = drafts.get(owner);
        const changes = turn.state === 'pending' && draft?.changes ? draft.changes : turn.changes;
        const node = h('div', { class: 'wb-msg-ai' },
            reads ? h('div', { class: 'wb-reads' }, icon('eye', { size: 12 }), h('span', { text: reads })) : null,
            turn.reasoning ? h('details', { class: 'wb-sent' },
                h('summary', null, icon('info', { size: 12 }), h('span', { text: i18n('Reasoning') })),
                h('pre', { class: 'wb-prompt-text', text: turn.reasoning })) : null,
            toolTraceBlock(turn.toolCalls),
            turn.error ? h('div', { class: 'wb-msg-error', text: turn.error }) : turn.text ? renderMarkdown(turn.text) : null);

        const last = index === session.turns.length - 1;
        const acts = msgActions([
            { iconName: 'copy', label: i18n('Copy'), done: i18n('Copied'), disabled: !turnText(turn), onClick: () => copyText(turnText(turn)) },
            last ? {
                iconName: 'refresh',
                label: i18n('Answer again'),
                title: canRegen(turn) ? i18n('Discard this round and let the AI redo it') : i18n('This round has been applied — undo it first to answer again'),
                disabled: busy || !canRegen(turn),
                onClick: () => regenerate(),
            } : null,
            {
                iconName: 'fork',
                label: i18n('Branch from here'),
                title: i18n('Copy up to this message into a new chat and continue editing there'),
                disabled: busy,
                onClick: async () => {
                    const forked = await forkAt(index + 1);
                    if (forked) {
                        app.toast(i18n('Branched into a new chat — the original is still in the chat list'));
                        input.focus({ preventScroll: true });
                    }
                },
            },
        ]);

        if (changes?.length) {
            const card = changeList({
                changes,
                state: turn.state || 'pending',
                target: turn.target || '',
                note: app.settings().reviewChanges !== false ? '' : i18n('Applied automatically. You can undo it in Change history'),
                onApply: (keys) => apply(owner, index, keys),
                onDiscard: () => discard(owner, index),
                onUndo: turn.historyId && app.history.canUndo(turn.historyId) ? () => undoTurn(owner, index) : null,
            });
            put(node, card.el);
        }
        put(node, acts);
        return node;
    }

    function paintOpts() {
        clear(chips);
        const t = selectDefaultTarget();
        const chipList = t
            ? (typeof t.chips === 'function' ? t.chips() : (Array.isArray(t.chips) ? t.chips : (DEFAULT_CHIPS[t.id]?.() || [])))
            : [];
        put(chips, chipList.map(c => h('button', { type: 'button', class: 'wb-chip', onClick: () => { input.value = c; grow(); input.focus({ preventScroll: true }); } }, c)));
        clear(opts);
        const s = app.settings();
        const busy = currentBusy();
        put(opts,
            checkRow({ checked: withReply, label: i18n('Include the latest reply'), onChange: (v) => { withReply = v; } }),
            checkRow({
                checked: s.reviewChanges === false,
                label: i18n('Apply automatically'),
                onChange: (v) => {
                    const n = clone(app.settings());
                    n.reviewChanges = !v;
                    app.saveSettings(n);
                    paintBody();
                },
            }));
        sendBtn.disabled = busy;
        input.disabled = busy;
    }

    function paintAll() {
        paintSessions();
        paintHead();
        paintBody();
        paintOpts();
        paintPreview();
        void ensureWork();
    }

    // ----- working copies -------------------------------------------------
    const keyOf = (w = ws, s = scope) => {
        if (s === 'character') return `${w}:${s}:${charAvatar()}`;
        if (s === 'preset') return `${w}:${s}:${presetName()}`;
        if (s === 'chat') return `${w}:${s}:${JSON.stringify(chatTarget() || app.snapshot()?.chat?.chatId || '')}`;
        return `${w}:${s}`;
    };

    const targetIdFor = (target, targetObj = selectDefaultTarget()) => (
        typeof targetObj?.targetKey === 'function'
            ? String(targetObj.targetKey(target))
            : JSON.stringify(target ?? {})
    );

    async function reloadCurrentWork() {
        const k = keyOf();
        work.delete(k);
        return ensureWork();
    }

    async function ensureWork() {
        const t = selectDefaultTarget();
        if (!t || blocked()) return null;
        const k = keyOf();
        if (work.has(k)) return work.get(k);
        const ver = ++workLoadVersion;
        try {
            const res = await t.load(scope, getCtx());
            if (ver !== workLoadVersion || keyOf() !== k) return null;
            const w = { base: res.live, target: res.target, title: res.title };
            work.set(k, w);
            loadError = '';
            paintControls();
            paintPreview();
            if (!session?.turns?.length && !currentBusy()) paintBody();
            return w;
        } catch (err) {
            if (ver === workLoadVersion) {
                loadError = String(err?.message || err);
                paintBody();
            }
            return null;
        }
    }

    // ----- send -----------------------------------------------------------
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

    function replayMessagesForApi(storedMessages = []) {
        const out = [];
        for (const m of Array.isArray(storedMessages) ? storedMessages : []) {
            if (!m || typeof m !== 'object') continue;
            if (m.role === 'system') continue;
            if (m.role === 'user' && m.auto === true) continue;
            if (m.role === 'assistant' && !m.tool_calls && String(m.content ?? '').trim() === '') continue;
            if ((m.role === 'user' || m.role === 'assistant') && !m.tool_calls && ('toolCalls' in m || 'reasoning' in m)) {
                if (isReplayableIterationMessage(m)) {
                    out.push({ role: m.role, content: String(m.content ?? '') });
                }
                continue;
            }
            out.push(m);
        }
        return out;
    }

    async function send(sendOpts = {}) {
        const isProgrammatic = typeof sendOpts?.promptText === 'string';
        const text = String(isProgrammatic ? sendOpts.promptText : input.value).trim();
        const hideFromUi = Boolean(sendOpts?.hideFromUi);
        const runTargetObj = selectDefaultTarget();
        if (!text || !runTargetObj || currentBusy() || applying.has(session?.id) || blocked() || !store) return;

        const selection = selectionVersion;
        const startingSession = session;
        const runWs = runTargetObj.id;
        const runScope = scope;
        const runScopeOpts = sessionScopes.get(startingSession?.id) || scopeOptsFor(runScope) || { scope: 'global' };
        const runKey = keyOf(runWs, runScope);
        const runScopeKey = currentScopeKey(runWs, runScope);
        const scopeName = scopeDisplayName(runScope);
        const stillViewingStart = () => selection === selectionVersion && runWs === ws && runScope === scope && session === startingSession;
        const stillViewingRunScope = () => runWs === ws && runScope === scope && currentScopeKey(ws, scope) === runScopeKey;

        if (!startingSession) pendingNewSelection = selection;
        paintOpts();

        let ownerId = startingSession?.id || '';
        let runId = '';
        let controller = null;

        try {
            let loaded;
            try {
                loaded = await runTargetObj.load(runScope, getCtx());
            } catch (err) {
                const msg = String(err?.message || err);
                if (stillViewingRunScope()) {
                    loadError = msg;
                    app.toast(loadError || i18n('Could not read what should be edited'), { error: true });
                }
                return;
            }
            if (stillViewingRunScope()) loadError = '';
            const w = { base: loaded.live, target: loaded.target, title: loaded.title };
            work.set(runKey, w);
            const id = targetIdFor(w.target, runTargetObj);

            let current = startingSession ? ((await store.get(startingSession.id, runScopeOpts)) || startingSession) : null;
            if (current?.targetId && current.targetId !== id) {
                app.toast(i18nFormat('This chat was editing something else (${0}). Start a new conversation to edit the current selection.', current.scopeName || targetName(runWs)), { error: true, duration: 7000 });
                return;
            }
            if (!current) {
                current = await store.create({
                    kind: 'iterate',
                    ws: runWs,
                    scope: runScope,
                    scopeName,
                    title: titleFrom(text),
                    messages: [],
                    targetId: id,
                }, runScopeOpts);
                ownerId = current.id;
                sessionScopes.set(ownerId, clone(runScopeOpts));
                if (pendingNewSelection === selection) pendingNewSelection = -1;
                if (stillViewingStart()) session = current;
            } else {
                ownerId = current.id;
                sessionScopes.set(ownerId, clone(runScopeOpts));
                if (!current.targetId) {
                    current = await store.update(ownerId, { targetId: id }, runScopeOpts);
                    if (session?.id === ownerId && current) session = current;
                }
            }

            const saveTo = async (patch) => {
                const updated = await store.update(ownerId, patch, runScopeOpts);
                if (updated) {
                    if (session?.id === ownerId) session = updated;
                    if (stillViewingRunScope()) {
                        const idx = recentSessions.findIndex(r => r.id === ownerId);
                        if (idx >= 0) recentSessions[idx] = updated;
                        else recentSessions = [updated, ...recentSessions];
                    }
                }
                return updated;
            };

            const priorTurns = (Array.isArray(current.turns) ? current.turns : [])
                .map(t => (t.state === 'pending' ? { ...t, state: 'discarded' } : t));
            const bus = runTargetObj.proposalKinds
                ? createIterateBus({ proposalKinds: runTargetObj.proposalKinds })
                : null;
            const draft = {
                base: clone(w.base),
                ai: clone(w.base),
                target: w.target,
                title: w.title,
                workKey: runKey,
                ws: runWs,
                bus,
                changes: [],
                proposalIds: [],
            };
            drafts.set(ownerId, draft);

            let userContent = current.note ? `${current.note}\n\n${text}` : text;
            if (!isProgrammatic && session?.id === ownerId && input.value.trim() === text) {
                input.value = '';
                grow();
            }
            if (withReply) {
                const reply = await app.source?.lastReply?.();
                if (reply) userContent += `\n\n<最近一条回复>\n${reply}\n</最近一条回复>`;
            }
            current = await saveTo({
                turns: [...priorTurns, { role: 'user', text, ...(hideFromUi ? { hidden: true } : {}), at: Date.now() }],
                note: '',
            });

            runId = `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
            controller = new AbortController();
            const run = { runId, sessionId: ownerId, ws: runWs, scope: runScope, abort: controller, liveStep: '' };
            activeRuns.set(runId, run);
            if (session?.id === ownerId) {
                paintHead();
                paintBody();
                paintOpts();
            }

            const turn = await runTurn({
                run,
                runTargetObj,
                runWs,
                runScope,
                current,
                draft,
                userContent,
                controller,
                saveTo,
            });
            const latest = (await store.get(ownerId, runScopeOpts)) || current;
            if (!latest) return;
            const updatedSession = await saveTo({ turns: [...latest.turns, turn] });
            if (turn.changes?.length && app.settings().reviewChanges === false && updatedSession) {
                await apply(ownerId, updatedSession.turns.length - 1, turn.changes.map(c => c.key));
            }
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
        } finally {
            if (pendingNewSelection === selection) pendingNewSelection = -1;
            if (runId) activeRuns.delete(runId);
            await refreshSessions();
            const viewingOwner = ownerId ? session?.id === ownerId : stillViewingStart();
            if (viewingOwner) {
                paintHead();
                paintBody();
                paintOpts();
                paintPreview();
            } else {
                paintOpts();
            }
            app.refreshBadges?.();
        }
    }

    /** One model turn. Never throws: failures become the turn's error text. */
    async function runTurn({ run, runTargetObj, runWs, runScope, current, draft, userContent, controller, saveTo }) {
        try {
            const ctx = getCtx();
            const wrapper = wrapperPrompt({
                wsName: targetLabel(runTargetObj),
                scopeText: draft.title,
                builtin: app.settings().builtinPrompt !== false,
            });
            const system = typeof runTargetObj.systemPrompt === 'function'
                ? await runTargetObj.systemPrompt(runScope, draft.ai, { wrapper, ctx, target: draft.target })
                : [wrapper, await runTargetObj.prompt(draft.ai, runScope, ctx, { wrapper, target: draft.target })].filter(Boolean).join('\n\n');
            const history = replayMessagesForApi(current.messages);
            const messages = trimMessages([{ role: 'system', content: system }, ...history, { role: 'user', content: userContent }]);
            const tools = await runTargetObj.tools(draft.ai, runScope, ctx, { target: draft.target });
            const result = await runIterateTurn({
                messages,
                live: draft.ai,
                tools,
                bus: draft.bus,
                proposalKinds: runTargetObj.proposalKinds || null,
                targetRef: draft.target,
                isRead: (n) => runTargetObj.isRead(n),
                runRead: (call, live, helpers) => runTargetObj.runRead(call, live, helpers),
                runEdit: (call, live, helpers) => runTargetObj.runEdit(call, live, helpers),
                request: (msgs, t) => app.source.aiRequest(runWs, { messages: msgs, tools: t, signal: controller.signal }),
                onRound: (info) => {
                    run.liveStep = i18nFormat('Read ${0} times, edited ${1} times…', info.reads, info.edits);
                    if (session?.id === run.sessionId) paintBody();
                },
                signal: controller.signal,
            });
            draft.ai = result.live;
            draft.bus = result.bus;
            draft.proposalIds = result.proposalIds || [];
            const changes = buildTurnChanges({
                base: draft.base,
                ai: draft.ai,
                units: runTargetObj.units,
                bus: draft.bus,
                proposalIds: draft.proposalIds,
                kindAdapters: runTargetObj.proposalKinds,
                targetRef: draft.target,
            });
            draft.changes = changes;
            if (!changes.length) drafts.delete(run.sessionId);

            const all = result.messages.filter(m => m.role !== 'system');
            const msgKeep = history.length;
            await saveTo({ messages: all });

            return {
                role: 'ai',
                text: result.text || (changes.length ? '' : i18n('(The AI made no changes)')),
                ...(result.reasoning ? { reasoning: result.reasoning } : {}),
                ...(result.toolCalls?.length ? { toolCalls: result.toolCalls } : {}),
                reads: result.reads.length,
                edits: result.edits.length,
                failed: result.failed.length,
                changes,
                proposalIds: draft.proposalIds,
                state: changes.length ? 'pending' : '',
                target: draft.title,
                msgKeep,
                at: Date.now(),
            };
        } catch (err) {
            drafts.delete(run.sessionId);
            return {
                role: 'ai',
                text: '',
                error: controller.signal.aborted ? i18n('Stopped.') : i18nFormat('Not changed: ${0}', err?.message || err),
                msgKeep: (current.messages || []).length,
                at: Date.now(),
            };
        }
    }

    // ----- decide ---------------------------------------------------------
    async function apply(id, index, keys) {
        const sOpts = sessionScopes.get(id) || scopeOptsFor() || { scope: 'global' };
        const owner = store ? await store.get(id, sOpts) : null;
        const turn = owner?.turns?.[index];
        if (!turn?.changes || applying.has(id)) return;
        const draft = drafts.get(id);
        const sessionTarget = targetById(owner.ws);
        if (!draft || !sessionTarget) {
            app.toast(i18n('This draft is no longer available. Ask the AI again.'), { error: true, duration: 7000 });
            return;
        }
        const liveChanges = buildTurnChanges({
            base: draft.base,
            ai: draft.ai,
            units: sessionTarget.units,
            bus: draft.bus,
            proposalIds: turn.proposalIds || draft.proposalIds || [],
            kindAdapters: sessionTarget.proposalKinds,
            targetRef: draft.target,
        });
        if (!approvalMatches(turn.changes, liveChanges, keys)) {
            app.toast(i18n('This draft is no longer available. Ask the AI again.'), { error: true, duration: 7000 });
            return;
        }

        applying.add(id);
        try {
            const handle = await commitTurnBatch({
                target: sessionTarget,
                targetRef: draft.target,
                base: draft.base,
                ai: draft.ai,
                keys,
                bus: draft.bus,
                proposalIds: turn.proposalIds || draft.proposalIds || [],
                kindAdapters: sessionTarget.proposalKinds,
            });
            const saved = new Set(handle.applied ?? keys);
            if (saved.size > 0 && pendingCancelHook) {
                pendingCancelHook.applied = true;
                pendingCancelHook = null;
            }
            const skipped = handle.skipped ?? [];
            const failure = handle.failure ?? '';
            const labelOf = (key) => turn.changes.find(c => c.key === key)?.label ?? key;
            const unsaved = skipped.map(s => labelOf(s.key));
            const labels = turn.changes.filter(c => saved.has(c.key)).map(c => c.label);
            const dropped = turn.changes.filter(c => !keys.includes(c.key)).map(c => c.label);
            const busOutcomes = draft.bus?.drainOutcomes?.() || [];
            const { workKey } = draft;
            const historyId = app.history.record({
                ws: owner.ws,
                title: `${owner.title}`,
                scope: draft.title,
                lines: turn.changes.filter(c => saved.has(c.key)).map(c => i18nFormat('${0} "${1}"', { add: i18n('Added'), remove: i18n('Removed item'), change: i18n('Edited') }[c.kind], c.label)),
                from: i18n('AI chat'),
                undo: handle.nonRollbackable && saved.size === 1
                    ? undefined
                    : async () => { await handle.undo(); work.delete(workKey); },
            });
            work.delete(workKey);
            drafts.delete(id);

            const fresh = await store.get(id, sOpts);
            if (fresh) {
                const updated = await store.update(id, {
                    turns: fresh.turns.map((x, i) => (i === index
                        ? { ...x, state: dropped.length || unsaved.length ? 'partial' : 'applied', historyId }
                        : x)),
                    note: decisionNote({ applied: labels, discarded: dropped, unsaved, busOutcomes }),
                }, sOpts);
                if (updated && session?.id === id) session = updated;
            }
            if (unsaved.length) {
                app.toast([i18nFormat('Saved ${0}, not saved: ${1}', saved.size, unsaved.join(listSeparator())), failure].filter(Boolean).join(' · '), {
                    error: true,
                    duration: 7000,
                    action: i18n('Undo'),
                    onAction: () => undoTurn(id, index),
                });
            } else {
                app.toast(i18nFormat('Applied ${0}', saved.size), handle.nonRollbackable && saved.size === 1 ? {} : {
                    action: i18n('Undo'),
                    onAction: () => undoTurn(id, index),
                });
            }
            app.reload?.();
        } catch (err) {
            app.toast(i18nFormat('Not saved: ${0}', err?.message || err), { error: true, duration: 7000 });
        } finally {
            applying.delete(id);
        }
        await refreshSessions();
        paintAll();
        app.refreshBadges?.();
    }

    async function discard(id, index) {
        const sOpts = sessionScopes.get(id) || scopeOptsFor() || { scope: 'global' };
        const owner = store ? await store.get(id, sOpts) : null;
        if (!owner) return;
        const turn = owner.turns[index];
        const draft = drafts.get(id);
        if (draft?.bus) {
            for (const pid of turn?.proposalIds || draft.proposalIds || []) {
                draft.bus.reject(pid);
            }
        }
        const busOutcomes = draft?.bus?.drainOutcomes?.() || [];
        drafts.delete(id);
        const turns = owner.turns.map((x, i) => (i === index ? { ...x, state: 'discarded' } : x));
        const updated = await store.update(id, {
            turns,
            note: decisionNote({ discarded: (turn?.changes || []).map(c => c.label), busOutcomes }),
        }, sOpts);
        if (updated && session?.id === id) session = updated;
        await refreshSessions();
        paintAll();
        app.refreshBadges?.();
    }

    async function undoTurn(id, index) {
        const sOpts = sessionScopes.get(id) || scopeOptsFor() || { scope: 'global' };
        const owner = store ? await store.get(id, sOpts) : null;
        const turn = owner?.turns?.[index];
        if (!turn?.historyId) return;
        try {
            await app.history.undo(turn.historyId);
            const fresh = await store.get(id, sOpts);
            if (fresh) {
                const updated = await store.update(id, {
                    turns: fresh.turns.map((x, i) => (i === index ? { ...x, state: 'discarded' } : x)),
                    note: `（用户撤销了上一轮应用的改动：${turn.changes.map(c => c.label).join(listSeparator())}。现在是改之前的样子。）`,
                }, sOpts);
                if (updated && session?.id === id) session = updated;
            }
            app.toast(i18n('Undone'));
            app.reload?.();
        } catch (err) {
            app.toast(i18nFormat('Could not undo: ${0}', err?.message || err), { error: true });
        }
        await refreshSessions();
        paintAll();
        app.refreshBadges?.();
    }

    // ----- refresh when Luker or registry changes -------------------------
    async function refreshScopes() {
        const ctx = getCtx();
        const out = {};
        for (const t of getTargets()) {
            if (typeof t.isEnabled === 'function') {
                try {
                    if (!t.isEnabled(ctx)) {
                        out[t.id] = { disabled: true };
                        continue;
                    }
                } catch (err) {
                    console.warn(`[workbench/iterate] isEnabled failed for "${t.id}":`, err);
                    out[t.id] = { disabled: true };
                    continue;
                }
            }
            try {
                out[t.id] = (await t.scopes?.(ctx)) || { global: true };
            } catch (err) {
                console.warn(`[workbench/iterate] scopes() failed for "${t.id}":`, err);
                out[t.id] = {};
            }
        }
        scopesByTarget = out;
    }

    function evictStaleWork() {
        const avatar = charAvatar();
        const pName = presetName();
        const chatKey = JSON.stringify(chatTarget() || app.snapshot()?.chat?.chatId || '');
        for (const k of [...work.keys()]) {
            if (k.includes(':character:') && !k.endsWith(`:${avatar}`)) work.delete(k);
            else if (k.includes(':preset:') && !k.endsWith(`:${pName}`)) work.delete(k);
            else if (k.includes(':chat:') && !k.endsWith(`:${chatKey}`)) work.delete(k);
        }
    }

    return {
        el,
        flush: true,
        async show(o = {}) {
            const version = ++selectionVersion;
            const targets = getTargets();
            if (!ws && targets.length) ws = targets[0].id;
            const seed = typeof o.seedPrompt === 'string' ? o.seedPrompt.trim() : '';
            pendingLaunch = o.launch && typeof o.launch === 'object' ? o.launch : null;
            const hasLaunchReset = Boolean(
                o.onCancelWithoutApply
                || (o.autoSend && seed)
                || o.sessionId
                || o.ws
                || (o.scope && o.scope !== scope),
            );
            if (hasLaunchReset) {
                void firePendingCancelHook();
            }
            if (typeof o.onCancelWithoutApply === 'function') {
                pendingCancelHook = { fn: o.onCancelWithoutApply, applied: false };
            }
            if (o.sessionId) {
                const sOpts = sessionScopes.get(o.sessionId) ?? null;
                const s = store ? await store.get(o.sessionId, sOpts) : null;
                if (version !== selectionVersion) return;
                if (s) {
                    session = s;
                    if (s.ws) ws = s.ws;
                    if (s.scope) {
                        scope = s.scope;
                        userPickedScope = true;
                    }
                }
            } else if (o.ws && o.ws !== ws) {
                ws = o.ws;
                session = null;
                if (o.scope) {
                    scope = o.scope;
                    userPickedScope = true;
                } else {
                    userPickedScope = false;
                }
            } else if (o.ws) {
                session = null;
                if (o.scope) {
                    scope = o.scope;
                    userPickedScope = true;
                } else {
                    userPickedScope = false;
                }
            } else if (o.scope) {
                scope = o.scope;
                userPickedScope = true;
            } else if (o.autoSend && seed) {
                session = null;
            }
            await refreshScopes();
            if (version !== selectionVersion) return;
            fixScope();
            activeScopeKey = currentScopeKey();
            paintAll();
            await refreshSessions();
            if (version !== selectionVersion) return;
            if (o.autoSend && seed) {
                await ensureWork();
                if (version !== selectionVersion) return;
                await send({ promptText: seed, hideFromUi: Boolean(o.hideSeedFromUi) });
            } else if (seed || o.draft) {
                input.value = seed || o.draft;
                grow();
            }
            requestAnimationFrame(() => input.focus({ preventScroll: true }));
        },
        onSnapshot() {
            evictStaleWork();
            const ver = ++snapshotVersion;
            refreshScopes().then(() => {
                if (ver !== snapshotVersion) return;
                fixScope();
                const nextKey = currentScopeKey();
                const scopeChanged = nextKey !== activeScopeKey;
                if (scopeChanged) {
                    activeScopeKey = nextKey;
                    selectionVersion++;
                    session = null;
                    recentSessions = [];
                    loadError = '';
                }
                if (el.isConnected && !currentBusy()) {
                    if (scopeChanged) paintAll();
                    else {
                        paintHead();
                        paintBody();
                        paintPreview();
                    }
                }
                void refreshSessions();
            });
        },
        onRegistryUpdate() {
            const ver = ++snapshotVersion;
            refreshScopes().then(() => {
                if (ver !== snapshotVersion) return;
                fixScope();
                activeScopeKey = currentScopeKey();
                if (el.isConnected) {
                    paintAll();
                    void refreshSessions();
                }
            });
        },
        pendingCount: () => recentSessions.reduce((n, s) => n + (pendingOf(s) ? 1 : 0), 0),
        pendingInfo() {
            const s = recentSessions.find(x => x.ws === 'card' && pendingOf(x));
            return s ? { pending: pendingOf(s), sessionTitle: s.title, sessionId: s.id } : null;
        },
        onEscape() {
            if (sessOpen) { sessOpen = false; paintSessions(); return true; }
            const run = currentRun();
            if (run) { run.abort?.abort(); return true; }
            return false;
        },
        onLayout() {
            paintPreview();
        },
        onCollapse() {
            return firePendingCancelHook();
        },
        destroy() {
            for (const run of activeRuns.values()) run.abort?.abort();
            activeRuns.clear();
            return firePendingCancelHook();
        },
    };
}
