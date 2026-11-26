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
import { confirmDialog } from '../../lens-shared/ui.js';
import { icon } from '../icons.js';
import { button, iconButton, checkRow, segmented, dot, msgActions, loading } from '../ui/components.js';
import { renderMarkdown } from '../ui/markdown.js';
import { changeList } from '../ui/change-list.js';
import { approvalMatches, diffUnits } from '../model/units.js';
import { same } from '../model/patch.js';
import {
    runIterateTurn,
    createIterateBus,
    serializeIterationDraft,
    restoreIterationDraft,
    buildTurnChanges,
    commitTurnBatch,
    wrapperPrompt,
    decisionNote,
    trimMessages,
} from '../model/iterate.js';
import { groupSessions, titleFrom, computePendingCount, toSessionSummary } from '../model/sessions.js';
import { isReplayableIterationMessage } from '../../iteration-library/iter-message-filter.js';
import { attachZoomOverlay } from '../../iteration-library/zoom-overlay.js';
import { withActivityLease } from '../../activity-guard.js';
import {
    createImageAttachmentTray,
    renderMessageAttachments,
} from '../../lens-shared/image-attachments.js';
import {
    collectAttachmentPathsFromRecords,
    hydrateMessagesForLlm,
    normalizeImageAttachments,
} from '../../lib/multimodal-messages.js';
import {
    copyChatAttachments,
    deleteChatAttachments,
    isAiAttachmentPath,
    rewriteAttachmentsWithCopyMap,
    uploadChatAttachments,
} from '../../lib/chat-attachments-store.js';

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
        global: () => i18n('Edit the memory structure and settings shared by all characters'),
        character: () => i18n('Edit only this character\'s own memory structure and settings (created on save if there is none)'),
    },
    memory_graph: {
        chat: () => i18n('Edit the memory nodes and relationships stored in this chat'),
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

function createSessionDraftStore() {
    /** @type {Map<string, Map<number, object>>} */
    const bySession = new Map();
    return {
        get(sessionId, turnIndex) {
            return bySession.get(sessionId)?.get(turnIndex) || null;
        },
        set(sessionId, turnIndex, draft) {
            let map = bySession.get(sessionId);
            if (!map) {
                map = new Map();
                bySession.set(sessionId, map);
            }
            map.set(turnIndex, draft);
        },
        deleteTurn(sessionId, turnIndex) {
            const map = bySession.get(sessionId);
            if (!map) return;
            map.delete(turnIndex);
            if (map.size === 0) bySession.delete(sessionId);
        },
        deleteSession(sessionId) {
            bySession.delete(sessionId);
        },
    };
}

function createReviewLifetimeController({ onCancelError }) {
    let active = null;

    function create(options) {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        return {
            fn: typeof options.onCancelWithoutApply === 'function' ? options.onCancelWithoutApply : null,
            owner: null,
            sessionId: options.sessionId || '',
            cancellation: null,
            promise,
            resolve,
        };
    }

    function fireCancelHook(review = active) {
        if (!review) return;
        if (!review.cancellation) {
            const fn = review.fn;
            review.fn = null;
            review.cancellation = Promise.resolve().then(() => fn?.()).catch(err => {
                onCancelError?.(err);
            });
        }
        return review.cancellation;
    }

    async function complete(review = active) {
        if (!review) return;
        if (active === review) active = null;
        await fireCancelHook(review);
        review.resolve();
    }

    return {
        get current() { return active; },
        set current(review) { active = review; },
        create,
        complete,
        suppressCancel(sessionId) {
            if (active?.sessionId === sessionId) active.fn = null;
        },
        bindSession(owner, sessionId) {
            if (active && !active.sessionId && same(active.owner, owner)) {
                active.sessionId = sessionId;
            }
        },
    };
}

function shallowTupleEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (!Object.is(a[i], b[i])) return false;
    }
    return true;
}

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
    const composer = h('div', { class: 'wb-composer' });
    const attachmentTray = createImageAttachmentTray({
        composerEl: composer,
        textareaEl: input,
        buttonClass: 'wb-att-btn',
        onError: (msg) => app.toast(msg, { error: true }),
    });
    put(
        composer,
        chips,
        attachmentTray.trayEl,
        h('div', { class: 'wb-input-row' }, attachmentTray.attachButton, attachmentTray.fileInput, input, sendBtn),
        opts,
    );
    const chat = h('section', { class: 'wb-chat' }, head, body, composer);
    const previewPane = h('aside', { class: 'wb-iter-preview', hidden: true });
    const el = h('div', { class: 'wb-page is-split' }, sess, chat, previewPane);
    const detachDiffOverlay = attachZoomOverlay(previewPane, { namespace: '.workbench_iteration_diff', i18n });

    let ws = '';
    let scope = 'character';
    let userPickedScope = false;
    let scopesByTarget = {};
    let session = null;
    let previewOpen = false;
    let recentSessions = [];
    const sessionScopes = new Map();
    let selectionVersion = 0;
    let pendingNewSelection = -1;
    let refreshVersion = 0;
    let snapshotVersion = 0;
    let workLoadVersion = 0;
    let activeScopeKey = '';
    let loadedSessionsScopeKey = '';
    const activeRuns = new Map();
    const pendingSessions = new Set();
    const applying = new Set();
    const deleting = new Set();
    let clearing = false;
    let previewDeps = null;

    // Saved copies per target+scope key: { base, target, title }
    const work = new Map();
    // Working copies belong to individual turns; pending turns share their session's bus.
    const draftStore = createSessionDraftStore();
    const draftOf = (id, index) => draftStore.get(id, index);
    const hasPendingDecision = owner => owner?.turns.some((_turn, index) => draftOf(owner.id, index)?.decision);

    function latestDraft(owner = session) {
        if (!owner) return null;
        const run = activeRunForSession(owner.id);
        if (run) return draftOf(owner.id, run.turnIndex);
        const index = owner.turns.findLastIndex(turn => turn.state === 'pending');
        return index < 0 ? null : draftOf(owner.id, index);
    }

    function restoreSessionDrafts(owner) {
        const target = targetById(owner.ws);
        if (!target) return;
        const restored = [];
        for (const [index, turn] of owner.turns.entries()) {
            if (turn.state !== 'pending' || !turn.draft) continue;
            const draft = draftOf(owner.id, index) || {
                ...restoreIterationDraft(turn.draft, { proposalKinds: target.proposalKinds, sessionId: owner.id, turnIndex: index }),
                changes: turn.changes,
            };
            if (targetIdFor(draft.target, target) !== owner.targetId) {
                throw new Error(`Draft target differs from session "${owner.id}" turn[${index}]`);
            }
            restored.push([index, draft]);
        }
        const bus = restored.at(-1)?.[1].bus || null;
        for (const [index, draft] of restored) {
            draft.bus = bus;
            draftStore.set(owner.id, index, draft);
        }
    }

    function capturePendingDrafts(id, turns) {
        return turns.map((turn, index) => {
            const draft = draftOf(id, index);
            return turn.state === 'pending' && draft
                ? { ...turn, draft: serializeIterationDraft(draft) }
                : turn;
        });
    }

    let withReply = true;
    let sessOpen = false;
    let loadError = '';
    const reviews = createReviewLifetimeController({
        onCancelError: (err) => {
            app.toast(i18nFormat('Could not cancel this review: ${0}', String(err?.message || err)), { error: true });
        },
    });
    let pendingLaunch = null;

    const getCtx = () => globalThis.Luker?.getContext?.() ?? globalThis.lukerContext ?? null;
    const hasNativeContext = () => typeof globalThis.Luker?.getContext === 'function' || Boolean(globalThis.lukerContext);
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
        if (hasNativeContext()) {
            const ctx = getCtx();
            return ctx?.groupId ? '' : String(ctx?.characters?.[ctx?.characterId]?.avatar || '').trim();
        }
        const snap = app.snapshot();
        return String(snap?.chat?.character?.avatar || snap?.card?.avatar || '').trim();
    };
    const presetRef = () => {
        if (hasNativeContext()) {
            const selected = getCtx()?.presets?.getSelected?.('openai');
            return selected?.name ? selected : null;
        }
        const snap = app.snapshot();
        if (snap?.preset?.ref?.name) return snap.preset.ref;
        return snap?.preset?.name ? { collection: 'openai', name: snap.preset.name } : null;
    };
    const presetName = () => String(presetRef()?.name || '');
    const chatTarget = () => {
        if (hasNativeContext()) return getCtx()?.resolveChatStateTarget?.() || null;
        return app.snapshot()?.chat?.target || null;
    };
    const chatIdentity = () => chatTarget() || (hasNativeContext() ? '' : app.snapshot()?.chat?.chatId || '');
    const chatLabel = () => String(app.snapshot()?.chat?.label || '');
    const hasChatScope = () => Boolean(chatIdentity());

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
    const currentBusy = () => Boolean(
        currentRun()
        || (session?.id && pendingSessions.has(session.id))
        || (!session && pendingNewSelection === selectionVersion),
    );

    // ----- sessions -------------------------------------------------------
    const isVisible = () => Boolean(el.isConnected && app.isOpen?.() !== false);

    function pendingOf(s) {
        return computePendingCount(s);
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
            loadedSessionsScopeKey = '';
            paintSessions();
            return;
        }

        const scopeKey = currentScopeKey(t.id, scope);
        try {
            const list = await store.list('iterate', sOpts);
            if (ver !== refreshVersion) return;

            for (const s of list) sessionScopes.set(s.id, clone(sOpts));
            recentSessions = list;
            loadedSessionsScopeKey = scopeKey;
            paintSessions();
            app.refreshBadges?.();
        } catch (err) {
            if (ver === refreshVersion) {
                recentSessions = [];
                loadedSessionsScopeKey = '';
                paintSessions();
                app.toast(String(err?.message || err), { error: true });
            }
        }
    }

    function paintSessions() {
        clear(sess);
        sess.classList.toggle('is-open', sessOpen);
        const list = recentSessions.filter(s => !ws || s.ws === ws);
        const canClear = Boolean(store && list.length && !clearing && !list.some(s => applying.has(s.id)));
        put(sess,
            h('div', { class: 'wb-sess-head' },
                button(i18n('New conversation'), () => newChat(), { iconName: 'plus' }),
                store && list.length ? iconButton('trash', i18n('Clear conversations'), () => { void clearVisibleSessions(list); }, {
                    className: 'wb-sess-clear',
                    size: 15,
                    disabled: !canClear,
                }) : null,
                sessOpen ? iconButton('x', i18n('Off'), () => { sessOpen = false; paintSessions(); }) : null),
            h('div', { class: 'wb-sess-list' },
                list.length ? groupSessions(list).map(g => [
                    h('div', { class: 'wb-src-group', text: g.label }),
                    g.items.map(s => {
                        const p = pendingOf(s);
                        return h('div', {
                            class: 'wb-sess-row',
                            dataset: { sessionId: s.id },
                        },
                        h('button', {
                            type: 'button',
                            class: 'wb-sess-item',
                            'aria-current': String(s.id === session?.id),
                            onClick: () => openSession(s.id),
                        },
                        dot(targetById(s.ws)?.tone || (s.ws === 'memory_graph' ? 'memory' : s.ws) || 'other'),
                        h('span', { class: 'wb-sess-main' },
                            h('span', { class: 'wb-sess-t', text: s.title }),
                            h('span', { class: 'wb-sess-m' },
                                `${targetName(s.ws)} · ${s.scopeName || scopeDisplayName(s.scope)} · ${relativeTime(s.updatedAt)}`,
                                p ? h('span', { class: 'wb-sess-p', text: i18nFormat(' · ${0} to confirm', p) }) : null))),
                        store ? iconButton('trash', i18n('Delete conversation'), (event) => {
                            event.stopPropagation();
                            void deleteSession(s);
                        }, {
                            className: 'wb-sess-del',
                            size: 14,
                            disabled: deleting.has(s.id) || applying.has(s.id) || clearing,
                        }) : null);
                    }),
                ]) : h('p', { class: 'wb-note wb-sess-empty', text: i18n('No chats yet.') })));
    }

    async function deleteSession(targetSession) {
        const id = targetSession?.id;
        if (!store || !id || deleting.has(id) || applying.has(id) || clearing) return;
        const confirmed = await confirmDialog(app.layer || el, {
            title: i18n('Delete conversation'),
            message: i18nFormat('Delete "${0}"? This cannot be undone.', targetSession.title || i18n('New conversation')),
            okLabel: i18n('Delete'),
            danger: true,
        });
        if (!confirmed) return;

        deleting.add(id);
        paintSessions();
        try {
            activeRunForSession(id)?.abort?.abort();
            const isCurrent = session?.id === id;
            if (isCurrent) {
                void reviews.complete();
            }
            const sOpts = sessionScopes.get(id) || scopeOptsFor(targetSession.scope) || { scope: 'global' };
            await store.remove(id, sOpts);
            draftStore.deleteSession(id);
            sessionScopes.delete(id);
            recentSessions = recentSessions.filter(x => x.id !== id);
            if (isCurrent) {
                selectionVersion++;
                session = null;
                paintAll();
            } else {
                paintSessions();
            }
            app.refreshBadges?.();
            app.toast(i18n('Conversation deleted'));
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
        } finally {
            deleting.delete(id);
            paintSessions();
        }
    }

    async function clearVisibleSessions(visibleList) {
        if (!store || clearing || !Array.isArray(visibleList) || !visibleList.length) return;
        if (visibleList.some(s => applying.has(s.id) || deleting.has(s.id))) return;
        const confirmed = await confirmDialog(app.layer || el, {
            title: i18n('Clear conversations'),
            message: i18nFormat('Delete all ${0} conversations under "${1}" (${2})? This cannot be undone.', visibleList.length, targetName(), scopeDisplayName()),
            okLabel: i18n('Clear all'),
            danger: true,
        });
        if (!confirmed) return;

        clearing = true;
        paintSessions();
        try {
            const ids = visibleList.map(s => s.id).filter(Boolean);
            const idSet = new Set(ids);
            for (const id of ids) {
                activeRunForSession(id)?.abort?.abort();
            }
            const clearedCurrent = Boolean(session?.id && idSet.has(session.id));
            if (clearedCurrent) {
                void reviews.complete();
            }
            const sOpts = scopeOptsFor() || { scope: 'global' };
            if (typeof store.removeMany === 'function') {
                await store.removeMany(ids, sOpts);
            } else {
                for (const id of ids) {
                    await store.remove(id, sessionScopes.get(id) || sOpts);
                }
            }
            for (const id of ids) {
                draftStore.deleteSession(id);
                sessionScopes.delete(id);
            }
            recentSessions = recentSessions.filter(x => !idSet.has(x.id));
            if (clearedCurrent) {
                selectionVersion++;
                session = null;
                paintAll();
            } else {
                paintSessions();
            }
            app.refreshBadges?.();
            app.toast(i18nFormat('Deleted ${0} conversations', ids.length));
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
            if (isVisible()) void refreshSessions();
        } finally {
            clearing = false;
            paintSessions();
        }
    }

    function newChat() {
        void reviews.complete();
        selectionVersion++;
        session = null;
        sessOpen = false;
        paintAll();
        input.focus({ preventScroll: true });
    }

    async function openSession(id) {
        void reviews.complete();
        const version = ++selectionVersion;
        const sOpts = sessionScopes.get(id) || scopeOptsFor() || { scope: 'global' };
        let loaded = store ? null : (recentSessions.find(x => x.id === id) || null);
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
        try {
            restoreSessionDrafts(loaded);
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
            return;
        }
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
        const currentDraft = latestDraft();
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
        const t = selectDefaultTarget();
        if ((app.isCompact?.() && !previewOpen) || !t || typeof t.renderPreview !== 'function' || blocked() || disabled()) {
            clear(previewPane);
            previewDeps = null;
            previewPane.hidden = true;
            if (!t || typeof t.renderPreview !== 'function' || blocked() || disabled()) {
                previewOpen = false;
            }
            el.classList.remove('is-preview-open');
            return;
        }
        const currentDraft = latestDraft();
        const w = work.get(keyOf());
        const base = currentDraft?.base ?? w?.base ?? null;
        const ai = currentDraft?.ai ?? w?.base ?? null;
        const target = currentDraft?.target ?? w?.target ?? null;
        const isPendingWork = !w && !currentDraft && !loadError;
        try {
            const nextDeps = [
                currentScopeKey(), session?.id, base, ai, target, session?.context, getCtx()?.getCurrentLocale?.(), isPendingWork,
            ];
            if (shallowTupleEqual(nextDeps, previewDeps)) {
                previewPane.hidden = !previewPane.firstChild;
                return;
            }
            const node = t.renderPreview({ base, ai, target, context: session?.context });
            clear(previewPane);
            if (node instanceof Node) {
                put(previewPane, node);
                previewPane.hidden = false;
            } else if (isPendingWork) {
                put(previewPane, loading());
                previewPane.hidden = false;
            } else {
                previewPane.hidden = true;
            }
            previewDeps = nextDeps;
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
            previewDeps = null;
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
                    void reviews.complete();
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
                    void reviews.complete();
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
            typeof t.renderPreview === 'function' ? iconButton('eye', i18n('Preview'), async () => {
                if (!await ensureWork()) return;
                previewOpen = !previewOpen;
                el.classList.toggle('is-preview-open', previewOpen);
                paintHead();
                paintPreview();
            }, { className: 'wb-preview-toggle', pressed: previewOpen }) : null,
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
        const attGrid = renderMessageAttachments(turn.attachments);
        return h('div', { class: 'wb-msg-turn' },
            h('div', { class: 'wb-msg-me' },
                turn.text ? h('div', { text: turn.text }) : null,
                attGrid),
            msgActions([
                { iconName: 'copy', label: i18n('Copy'), done: i18n('Copied'), disabled: !turn.text, onClick: () => copyText(turn.text) },
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
        const rawTurns = src.turns.slice(0, upto).map(t => (t.state === 'pending' ? { ...clone(t), state: 'discarded', draft: null } : clone(t)));
        const ctx = getCtx();
        const sourcePaths = collectAttachmentPathsFromRecords(rawTurns, { filter: isAiAttachmentPath });
        let copyMap = new Map();
        try {
            if (sourcePaths.length > 0) {
                copyMap = await copyChatAttachments(ctx, sourcePaths);
            }
            const turns = rawTurns.map(t => {
                if (t.role !== 'user' || !Array.isArray(t.attachments) || !t.attachments.length) return t;
                return { ...t, attachments: rewriteAttachmentsWithCopyMap(t.attachments, copyMap) };
            });
            const messages = turns.flatMap(t => {
                if (t.role === 'user') {
                    const atts = normalizeImageAttachments(t.attachments);
                    return [{
                        role: 'user',
                        content: t.text || '',
                        ...(atts.length ? { attachments: atts } : {}),
                    }];
                }
                return (t.text || t.changes?.length ? [{ role: 'assistant', content: turnText(t) }] : []);
            });
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
            if (copyMap.size > 0) {
                await deleteChatAttachments(ctx, [...copyMap.values()]).catch(() => {});
            }
            app.toast(String(err?.message || err), { error: true });
            return null;
        }
    }

    async function editMessage(i) {
        if (!session || currentBusy()) return;
        const targetTurn = session.turns[i];
        const text = targetTurn?.text || '';
        const origAttachments = normalizeImageAttachments(targetTurn?.attachments);
        const created = await forkAt(i);
        if (!created) return;
        input.value = text;
        if (origAttachments.length > 0) {
            attachmentTray.setManagedItems(origAttachments, { cloneOnCommit: true });
        } else {
            attachmentTray.clear();
        }
        grow();
        input.focus({ preventScroll: true });
    }

    const canRegen = (t) => !t.changes?.length || t.state === 'pending' || t.state === 'discarded'
        || ((t.state === 'applied' || t.state === 'partial')
            && (t.requiresUndo === false || app.history.canUndo(t.historyId)));

    async function regenerate() {
        if (!session || !store) return;
        if (hasPendingDecision(session)) {
            app.toast(i18n('Save the pending review decision before continuing.'), { error: true });
            return;
        }
        const version = selectionVersion;
        const targetSessionId = session.id;
        const turns = session.turns;
        const last = turns[turns.length - 1];
        const q = turns[turns.length - 2];
        if (currentBusy() || applying.has(targetSessionId) || !q || q.role !== 'user' || !canRegen(last)) return;
        const sOpts = sessionScopes.get(targetSessionId) || scopeOptsFor(session.scope) || { scope: 'global' };
        const keep = Number.isInteger(last.msgKeep) ? last.msgKeep : Math.max(0, (session.messages || []).length - 2);
        const reuseAttachments = normalizeImageAttachments(q.attachments);
        let readyToSend = false;
        try {
            if ((last.state === 'applied' || last.state === 'partial') && app.history.canUndo(last.historyId)) {
                if (!await undoTurn(targetSessionId, turns.length - 1)) return;
                if (version !== selectionVersion || session?.id !== targetSessionId) return;
                if (currentBusy() || applying.has(targetSessionId) || session.turns.length !== turns.length) return;
            }
            applying.add(targetSessionId);
            paintSessions();
            try {
                const lastIndex = turns.length - 1;
                const outcomeDraft = last.state === 'pending'
                    ? draftOf(targetSessionId, lastIndex)
                    : latestDraft();
                const discardIds = Array.isArray(last.proposalIds) && last.proposalIds.length
                    ? last.proposalIds
                    : (last.state === 'pending' && Array.isArray(outcomeDraft?.proposalIds) ? outcomeDraft.proposalIds : []);
                let nextBusState = null;
                if (outcomeDraft?.bus && discardIds.length) {
                    const sessionTarget = targetById(session.ws);
                    const stagedBus = createIterateBus({ proposalKinds: sessionTarget?.proposalKinds });
                    stagedBus.hydrate(outcomeDraft.bus.serialize());
                    stagedBus.discardEntries(discardIds);
                    nextBusState = stagedBus.serialize();
                }
                const nextTurns = capturePendingDrafts(targetSessionId, turns.slice(0, -2))
                    .map(x => (nextBusState && x.state === 'pending' && x.draft
                        ? { ...x, draft: { ...x.draft, busState: nextBusState } }
                        : x));
                const updated = await store.update(targetSessionId, {
                    turns: nextTurns,
                    messages: (session.messages || []).slice(0, keep),
                    note: '',
                }, sOpts);
                if (!updated) return;
                if (outcomeDraft?.bus && discardIds.length) {
                    outcomeDraft.bus.discardEntries(discardIds);
                }
                draftStore.deleteTurn(targetSessionId, lastIndex);
                if (version !== selectionVersion || session?.id !== targetSessionId) return;
                session = updated;
                readyToSend = true;
            } finally {
                applying.delete(targetSessionId);
                paintSessions();
            }
            if (readyToSend) {
                if (q.hidden) {
                    await send({ promptText: q.text, hideFromUi: true, reuseAttachments });
                } else {
                    input.value = q.text || '';
                    await send({ reuseAttachments });
                }
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
        const draft = draftOf(owner, index);
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
                title: canRegen(turn) ? i18n('Discard this round and let the AI redo it') : i18n('This change was made in an earlier session and can no longer be undone here'),
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
        attachmentTray.setDisabled(busy);
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
        if (s === 'chat') return `${w}:${s}:${JSON.stringify(chatIdentity())}`;
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
                paintPreview();
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
            const hasNativeReplay = (Array.isArray(m.native_parts) && m.native_parts.length > 0)
                || (Array.isArray(m.native_content_blocks) && m.native_content_blocks.length > 0)
                || (Array.isArray(m.responses_output_items) && m.responses_output_items.length > 0);
            if (m.role === 'assistant' && !m.tool_calls && !hasNativeReplay && String(m.content ?? '').trim() === '') continue;
            if ((m.role === 'user' || m.role === 'assistant') && !m.tool_calls && ('toolCalls' in m || 'reasoning' in m)) {
                if (isReplayableIterationMessage(m) || hasNativeReplay) {
                    const replayed = { role: m.role, content: String(m.content ?? '') };
                    if (m.role === 'user') {
                        const atts = normalizeImageAttachments(m.attachments);
                        if (atts.length) replayed.attachments = atts;
                    } else if (m.role === 'assistant') {
                        if (typeof m.reasoning === 'string' && m.reasoning.length > 0) replayed.reasoning = m.reasoning;
                        if (typeof m.signature === 'string' && m.signature.length > 0) replayed.signature = m.signature;
                        if (Array.isArray(m.reasoning_blocks) && m.reasoning_blocks.length > 0) replayed.reasoning_blocks = m.reasoning_blocks;
                        if (Array.isArray(m.reasoning_details) && m.reasoning_details.length > 0) replayed.reasoning_details = m.reasoning_details;
                        if (Array.isArray(m.native_parts) && m.native_parts.length > 0) replayed.native_parts = m.native_parts;
                        if (Array.isArray(m.native_content_blocks) && m.native_content_blocks.length > 0) replayed.native_content_blocks = m.native_content_blocks;
                        if (Array.isArray(m.responses_output_items) && m.responses_output_items.length > 0) replayed.responses_output_items = m.responses_output_items;
                    }
                    out.push(replayed);
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
        const hasReuseAttachments = Array.isArray(sendOpts?.reuseAttachments);
        const hasTrayAttachments = !isProgrammatic && !hasReuseAttachments && attachmentTray.hasItems();
        const hasAnyAttachments = (hasReuseAttachments && sendOpts.reuseAttachments.length > 0) || hasTrayAttachments;
        const runTargetObj = selectDefaultTarget();
        if ((!text && !hasAnyAttachments) || !runTargetObj || currentBusy() || applying.has(session?.id) || blocked() || !store) return;
        if (hasPendingDecision(session)) {
            app.toast(i18n('Save the pending review decision before continuing.'), { error: true });
            return;
        }

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

        let ownerId = startingSession?.id || '';
        if (ownerId) pendingSessions.add(ownerId);
        else pendingNewSelection = selection;
        paintOpts();

        let runId = '';
        let controller = null;
        let newlyCreatedAttachmentPaths = [];
        let turnPersisted = false;

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

            let current = startingSession ? await store.get(startingSession.id, runScopeOpts) : null;
            if (startingSession && !current) return;
            if (current?.targetId && current.targetId !== id) {
                app.toast(i18nFormat('This chat was editing something else (${0}). Start a new conversation to edit the current selection.', current.scopeName || targetName(runWs)), { error: true, duration: 7000 });
                return;
            }

            const ctx = getCtx();
            let attachments = [];
            if (hasReuseAttachments) {
                attachments = normalizeImageAttachments(sendOpts.reuseAttachments);
            } else if (hasTrayAttachments) {
                attachments = await attachmentTray.commit(
                    async (files) => {
                        const uploaded = await uploadChatAttachments(ctx, files);
                        for (const item of uploaded) newlyCreatedAttachmentPaths.push(item.path);
                        return uploaded;
                    },
                    {
                        cloneManaged: async (paths) => {
                            const map = await copyChatAttachments(ctx, paths);
                            for (const copiedPath of map.values()) newlyCreatedAttachmentPaths.push(copiedPath);
                            return map;
                        },
                        clearAfter: false,
                    },
                );
            }
            if (!current) {
                current = await store.create({
                    kind: 'iterate',
                    ws: runWs,
                    scope: runScope,
                    scopeName,
                    title: titleFrom(text, attachments),
                    messages: [],
                    targetId: id,
                    ...(sendOpts?.context ? { context: clone(sendOpts.context) } : {}),
                }, runScopeOpts);
                ownerId = current.id;
                pendingSessions.add(ownerId);
                sessionScopes.set(ownerId, clone(runScopeOpts));
                if (pendingNewSelection === selection) pendingNewSelection = -1;
                if (stillViewingStart()) session = current;
            } else {
                ownerId = current.id;
                sessionScopes.set(ownerId, clone(runScopeOpts));
                if (!current.targetId) {
                    current = await store.update(ownerId, { targetId: id }, runScopeOpts);
                    if (!current) return;
                    if (session?.id === ownerId) session = current;
                }
            }
            reviews.bindSession({ ws: runWs, scope: runScopeOpts }, ownerId);

            const saveTo = async (patch) => {
                const updated = await store.update(ownerId, patch, runScopeOpts);
                if (updated) {
                    if (session?.id === ownerId) session = updated;
                    if (stillViewingRunScope()) {
                        const summary = toSessionSummary(updated);
                        const idx = recentSessions.findIndex(r => r.id === ownerId);
                        if (idx >= 0) recentSessions[idx] = summary;
                        else recentSessions = [summary, ...recentSessions];
                    }
                }
                return updated;
            };

            restoreSessionDrafts(current);
            const priorTurns = current.turns;
            const pendingIndex = priorTurns.findLastIndex(turn => turn.state === 'pending');
            const previous = pendingIndex < 0 ? null : draftOf(ownerId, pendingIndex);
            if (pendingIndex >= 0 && !previous) {
                throw new Error(i18n('This draft is no longer available. Ask the AI again.'));
            }
            const bus = previous ? previous.bus : runTargetObj.proposalKinds
                ? createIterateBus({ proposalKinds: runTargetObj.proposalKinds })
                : null;
            let base = w.base;
            for (const [index, turn] of priorTurns.entries()) {
                if (turn.state !== 'pending') continue;
                const pending = draftOf(ownerId, index);
                if (!pending) {
                    throw new Error(i18n('This draft is no longer available. Ask the AI again.'));
                }
                const keys = diffUnits(
                    runTargetObj.units(pending.base, pending.target),
                    runTargetObj.units(pending.ai, pending.target),
                ).map(change => change.key);
                base = runTargetObj.rebuild(base, pending.ai, keys, pending.target);
            }
            const turnIndex = priorTurns.length + 1;
            const draft = {
                base: clone(base),
                ai: clone(base),
                target: w.target,
                title: w.title,
                workKey: runKey,
                ws: runWs,
                bus,
                changes: [],
                proposalIds: [],
            };
            draftStore.set(ownerId, turnIndex, draft);

            let userContent = current.note ? `${current.note}\n\n${text}` : text;
            if (!isProgrammatic && session?.id === ownerId && input.value.trim() === text) {
                input.value = '';
                grow();
            }
            if (withReply) {
                const reply = await app.source?.lastReply?.();
                if (reply) userContent += `${userContent ? '\n\n' : ''}<最近一条回复>\n${reply}\n</最近一条回复>`;
            }
            current = await saveTo({
                turns: [
                    ...priorTurns,
                    {
                        role: 'user',
                        text,
                        ...(attachments.length ? { attachments } : {}),
                        ...(hideFromUi ? { hidden: true } : {}),
                        at: Date.now(),
                    },
                ],
                note: '',
            });
            if (!current) {
                draftStore.deleteTurn(ownerId, turnIndex);
                return;
            }
            turnPersisted = true;
            if (hasTrayAttachments && selection === selectionVersion && session?.id === ownerId) {
                attachmentTray.clear();
            }

            runId = `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
            controller = new AbortController();
            const run = { runId, sessionId: ownerId, turnIndex, ws: runWs, scope: runScope, abort: controller, liveStep: '' };
            activeRuns.set(runId, run);
            pendingSessions.delete(ownerId);
            if (session?.id === ownerId) {
                paintHead();
                paintBody();
                paintOpts();
                paintPreview();
            }

            const { turn, messages: nextMessages } = await runTurn({
                run,
                runTargetObj,
                runWs,
                runScope,
                current,
                draft,
                userContent,
                attachments,
                controller,
            });
            const latest = await store.get(ownerId, runScopeOpts);
            if (!latest) return;
            const updatedSession = await saveTo({
                turns: [...latest.turns, turn],
                ...(nextMessages ? { messages: nextMessages } : {}),
            });
            if (turn.changes?.length && app.settings().reviewChanges === false && updatedSession) {
                await apply(ownerId, updatedSession.turns.length - 1, turn.changes.map(c => c.key));
            }
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
        } finally {
            if (!turnPersisted && newlyCreatedAttachmentPaths.length > 0) {
                await deleteChatAttachments(getCtx(), newlyCreatedAttachmentPaths).catch(() => {});
            }
            if (pendingNewSelection === selection) pendingNewSelection = -1;
            if (ownerId) pendingSessions.delete(ownerId);
            if (runId) activeRuns.delete(runId);
            if (isVisible()) {
                await refreshSessions();
            } else {
                loadedSessionsScopeKey = '';
            }
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
    async function runTurn({ run, runTargetObj, runWs, runScope, current, draft, userContent, attachments = [], controller }) {
        const priorProposalIds = new Set(draft.bus?.listEntries().map(entry => entry.id) || []);
        try {
            return await withActivityLease({
                source: 'workbench:iterate',
                label: i18n('Workbench AI iteration'),
                scope: runScope === 'chat' ? 'chat' : 'global',
                onCancel: () => controller.abort(),
            }, async () => {
                const ctx = getCtx();
                const wrapper = wrapperPrompt({
                    wsName: targetLabel(runTargetObj),
                    scopeText: draft.title,
                    builtin: app.settings().builtinPrompt !== false,
                });
                const system = typeof runTargetObj.systemPrompt === 'function'
                    ? await runTargetObj.systemPrompt(runScope, draft.ai, { wrapper, ctx, target: draft.target })
                    : [wrapper, await runTargetObj.prompt(draft.ai, runScope, ctx, { wrapper, target: draft.target })].filter(Boolean).join('\n\n');
                const history = replayMessagesForApi(current?.messages);
                const normalizedAtts = normalizeImageAttachments(attachments);
                const userMsg = {
                    role: 'user',
                    content: userContent,
                    ...(normalizedAtts.length ? { attachments: normalizedAtts } : {}),
                };
                const messages = trimMessages([{ role: 'system', content: system }, ...history, userMsg]);
                const tools = await runTargetObj.tools(draft.ai, runScope, ctx, { target: draft.target });
                const imageCache = new Map();
                const hasAttachments = messages.some(m => Array.isArray(m?.attachments) && m.attachments.length > 0);
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
                    request: async (msgs, t) => {
                        const outbound = hasAttachments
                            ? await hydrateMessagesForLlm(msgs, {
                                context: ctx,
                                cache: imageCache,
                                signal: controller.signal,
                            })
                            : msgs;
                        return await app.source.aiRequest(runWs, { messages: outbound, tools: t, signal: controller.signal });
                    },
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
                if (!changes.length) draftStore.deleteTurn(run.sessionId, run.turnIndex);

                const all = result.messages.filter(m => m.role !== 'system');
                const msgKeep = history.length;

                return {
                    messages: all,
                    turn: {
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
                        ...(changes.length ? { draft: serializeIterationDraft(draft) } : {}),
                        target: draft.title,
                        msgKeep,
                        at: Date.now(),
                    },
                };
            });
        } catch (err) {
            if (draft.bus) {
                draft.bus.discardEntries(draft.bus.listEntries()
                    .filter(entry => !priorProposalIds.has(entry.id))
                    .map(entry => entry.id));
            }
            draftStore.deleteTurn(run.sessionId, run.turnIndex);
            return {
                messages: null,
                turn: {
                    role: 'ai',
                    text: '',
                    error: controller.signal.aborted ? i18n('Stopped.') : i18nFormat('Not changed: ${0}', err?.message || err),
                    msgKeep: (current?.messages || []).length,
                    at: Date.now(),
                },
            };
        }
    }

    // ----- decide ---------------------------------------------------------
    async function apply(id, index, keys) {
        const sOpts = sessionScopes.get(id) || scopeOptsFor() || { scope: 'global' };
        const owner = store ? await store.get(id, sOpts) : null;
        const turn = owner?.turns?.[index];
        if (!turn?.changes || applying.has(id)) return;
        const draft = draftOf(id, index);
        const sessionTarget = targetById(owner.ws);
        if (!draft || !sessionTarget) {
            app.toast(i18n('This draft is no longer available. Ask the AI again.'), { error: true, duration: 7000 });
            return;
        }
        if (!draft.decision) {
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
        }

        applying.add(id);
        try {
            if (!draft.decision) {
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
                if (saved.size > 0) {
                    reviews.suppressCancel(id);
                }
                const skipped = handle.skipped ?? [];
                const labelOf = (key) => turn.changes.find(c => c.key === key)?.label ?? key;
                const unsaved = skipped.map(s => labelOf(s.key));
                const labels = turn.changes.filter(c => saved.has(c.key)).map(c => c.label);
                const dropped = turn.changes.filter(c => !keys.includes(c.key)).map(c => c.label);
                const busOutcomes = draft.bus?.drainOutcomes?.() || [];
                const { workKey } = draft;
                const requiresUndo = !(handle.nonRollbackable && saved.size === 1);
                const historyId = app.history.record({
                    ws: owner.ws,
                    title: `${owner.title}`,
                    scope: draft.title,
                    lines: turn.changes.filter(c => saved.has(c.key)).map(c => i18nFormat('${0} "${1}"', { add: i18n('Added'), remove: i18n('Removed item'), change: i18n('Edited') }[c.kind], c.label)),
                    from: i18n('AI chat'),
                    undo: requiresUndo ? async () => { await handle.undo(); work.delete(workKey); } : undefined,
                });
                draft.decision = {
                    state: dropped.length || unsaved.length ? 'partial' : 'applied',
                    historyId, requiresUndo, savedCount: saved.size, unsaved,
                    failure: handle.failure ?? '',
                    note: decisionNote({ applied: labels, discarded: dropped, unsaved, busOutcomes }),
                };
            }
            const { state, historyId, requiresUndo, savedCount, unsaved, failure, note } = draft.decision;
            const fresh = await store.get(id, sOpts);
            if (!fresh) throw new Error(i18nFormat('Session "${0}" no longer exists. The review decision was not saved.', id));
            const updated = await store.update(id, {
                turns: capturePendingDrafts(id, fresh.turns.map((x, i) => (i === index
                    ? { ...x, state, historyId, requiresUndo, draft: null }
                    : x))),
                note,
            }, sOpts);
            if (!updated) throw new Error(i18nFormat('Session "${0}" no longer exists. The review decision was not saved.', id));
            if (session?.id === id) session = updated;
            work.delete(draft.workKey);
            draftStore.deleteTurn(id, index);
            if (unsaved.length) {
                app.toast([i18nFormat('Saved ${0}, not saved: ${1}', savedCount, unsaved.join(listSeparator())), failure].filter(Boolean).join(' · '), {
                    error: true,
                    duration: 7000,
                    action: i18n('Undo'),
                    onAction: () => undoTurn(id, index),
                });
            } else {
                app.toast(i18nFormat('Applied ${0}', savedCount), !requiresUndo ? {} : {
                    action: i18n('Undo'),
                    onAction: () => undoTurn(id, index),
                });
            }
            app.reload?.();
        } catch (err) {
            const detail = err?.message || err;
            app.toast(draft.decision
                ? i18nFormat(draft.decision.savedCount
                    ? 'Changes saved. Could not save the review decision: ${0}'
                    : 'Could not save the review decision: ${0}', detail)
                : i18nFormat('Not saved: ${0}', detail), {
                error: true, duration: 7000,
                ...(draft.decision ? { action: i18n('Retry'), onAction: () => apply(id, index, keys) } : {}),
            });
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
        if (!owner || applying.has(id)) return;
        const turn = owner.turns[index];
        const draft = draftOf(id, index);
        if (draft?.decision) {
            app.toast(i18n('Changes are already saved. Retry Apply to finish recording the review decision.'), { error: true });
            return;
        }
        applying.add(id);
        try {
            const sessionTarget = targetById(owner.ws);
            const staged = draft && sessionTarget ? restoreIterationDraft(serializeIterationDraft(draft), {
                proposalKinds: sessionTarget.proposalKinds, sessionId: id, turnIndex: index,
            }) : null;
            const proposalIds = turn?.proposalIds || draft?.proposalIds || [];
            if (staged?.bus) {
                for (const pid of proposalIds) staged.bus.reject(pid);
            }
            const busOutcomes = staged?.bus?.drainOutcomes?.() || [];
            const busState = staged?.bus?.serialize?.() || null;

            // Rebase any later stacked pending turns onto the current saved base
            // plus earlier remaining pending turns so their diffs reflect any
            // applied/external changes while dropping only the discarded turn.
            const rebasedDrafts = new Map();
            const hasLaterPending = Boolean(
                draft
                && sessionTarget
                && typeof sessionTarget.units === 'function'
                && typeof sessionTarget.rebuild === 'function'
                && owner.turns.slice(index + 1).some((t, offset) => t?.state === 'pending' && Boolean(draftOf(id, index + 1 + offset))),
            );
            if (hasLaterPending) {
                let savedBase;
                if (typeof sessionTarget.load === 'function') {
                    const loaded = await sessionTarget.load(owner.scope, getCtx());
                    if (owner.targetId && targetIdFor(loaded.target, sessionTarget) !== owner.targetId) {
                        throw new Error(i18nFormat('This chat was editing something else (${0}). Start a new conversation to edit the current selection.', owner.scopeName || targetName(owner.ws)));
                    }
                    savedBase = loaded.live;
                    work.set(draft.workKey, { base: loaded.live, target: loaded.target, title: loaded.title });
                } else {
                    savedBase = work.get(draft.workKey)?.base ?? draft.base;
                }
                let runningBase = clone(savedBase);
                for (let i = 0; i < index; i++) {
                    if (owner.turns[i]?.state !== 'pending') continue;
                    const earlierDraft = draftOf(id, i);
                    if (!earlierDraft) continue;
                    const earlierKeys = diffUnits(
                        sessionTarget.units(earlierDraft.base, earlierDraft.target),
                        sessionTarget.units(earlierDraft.ai, earlierDraft.target),
                    ).map(change => change.key);
                    if (earlierKeys.length) {
                        runningBase = sessionTarget.rebuild(runningBase, earlierDraft.ai, earlierKeys, earlierDraft.target);
                    }
                }
                for (let i = index + 1; i < owner.turns.length; i++) {
                    const laterTurn = owner.turns[i];
                    if (laterTurn?.state !== 'pending') continue;
                    const laterDraft = draftOf(id, i);
                    if (!laterDraft) continue;
                    const ownKeys = diffUnits(
                        sessionTarget.units(laterDraft.base, laterDraft.target),
                        sessionTarget.units(laterDraft.ai, laterDraft.target),
                    ).map(change => change.key);
                    const nextBase = clone(runningBase);
                    const nextAi = ownKeys.length
                        ? sessionTarget.rebuild(clone(nextBase), laterDraft.ai, ownKeys, laterDraft.target)
                        : clone(nextBase);
                    const nextChanges = buildTurnChanges({
                        base: nextBase,
                        ai: nextAi,
                        units: sessionTarget.units,
                        bus: staged?.bus ?? laterDraft.bus,
                        proposalIds: laterTurn.proposalIds || laterDraft.proposalIds || [],
                        kindAdapters: sessionTarget.proposalKinds,
                        targetRef: laterDraft.target,
                    });
                    rebasedDrafts.set(i, {
                        draft: laterDraft,
                        base: nextBase,
                        ai: nextAi,
                        changes: nextChanges,
                    });
                    runningBase = nextAi;
                }
            }

            const turns = owner.turns.map((x, i) => {
                if (i === index) return { ...x, state: 'discarded', draft: null };
                const rebased = rebasedDrafts.get(i);
                if (rebased) {
                    const updatedDraft = { ...rebased.draft, base: rebased.base, ai: rebased.ai, changes: rebased.changes };
                    return rebased.changes.length
                        ? { ...x, changes: rebased.changes, draft: serializeIterationDraft(updatedDraft) }
                        : { ...x, changes: [], state: 'discarded', draft: null };
                }
                const existingDraft = draftOf(id, i);
                return x.state === 'pending' && existingDraft
                    ? { ...x, draft: serializeIterationDraft(existingDraft) }
                    : x;
            }).map(x => busState && x.state === 'pending' && x.draft ? { ...x, draft: { ...x.draft, busState } } : x);

            const updated = await store.update(id, {
                turns,
                note: decisionNote({ discarded: (turn?.changes || []).map(c => c.label), busOutcomes }),
            }, sOpts);
            if (!updated) throw new Error(i18nFormat('Session "${0}" no longer exists. The review decision was not saved.', id));
            if (draft?.bus) {
                for (const pid of proposalIds) draft.bus.reject(pid);
                draft.bus.drainOutcomes?.();
            }
            for (const [laterIdx, rebased] of rebasedDrafts.entries()) {
                if (rebased.changes.length) {
                    rebased.draft.base = rebased.base;
                    rebased.draft.ai = rebased.ai;
                    rebased.draft.changes = rebased.changes;
                } else {
                    draftStore.deleteTurn(id, laterIdx);
                }
            }
            draftStore.deleteTurn(id, index);
            if (session?.id === id) session = updated;
        } catch (err) {
            app.toast(i18nFormat('Could not save the review decision: ${0}', err?.message || err), { error: true, duration: 7000 });
        } finally {
            applying.delete(id);
        }
        await refreshSessions();
        paintAll();
        app.refreshBadges?.();
    }

    async function undoTurn(id, index) {
        if (applying.has(id)) return false;
        const sOpts = sessionScopes.get(id) || scopeOptsFor() || { scope: 'global' };
        const owner = store ? await store.get(id, sOpts) : null;
        const turn = owner?.turns?.[index];
        if (!turn?.historyId || applying.has(id)) return false;
        applying.add(id);
        paintSessions();
        let undone = false;
        try {
            await app.history.undo(turn.historyId);
            const fresh = await store.get(id, sOpts);
            if (fresh) {
                // Later pending turns were based on the now-undone state; clear
                // their stale drafts and bus entries so they cannot silently
                // re-apply undone edits.
                const stalePendingIndices = [];
                const staleProposalIds = [];
                let sharedBus = null;
                for (let i = index + 1; i < fresh.turns.length; i++) {
                    if (fresh.turns[i]?.state === 'pending') {
                        stalePendingIndices.push(i);
                        const staleDraft = draftOf(id, i);
                        if (!sharedBus && staleDraft?.bus) sharedBus = staleDraft.bus;
                        const pids = fresh.turns[i]?.proposalIds || staleDraft?.proposalIds || [];
                        staleProposalIds.push(...pids);
                    }
                }
                let nextBusState = null;
                if (sharedBus && staleProposalIds.length) {
                    const sessionTarget = targetById(fresh.ws);
                    const stagedBus = createIterateBus({ proposalKinds: sessionTarget?.proposalKinds });
                    stagedBus.hydrate(sharedBus.serialize());
                    stagedBus.discardEntries(staleProposalIds);
                    nextBusState = stagedBus.serialize();
                }
                const nextTurns = capturePendingDrafts(id, fresh.turns.map((x, i) => {
                    if (i === index) return { ...x, state: 'discarded' };
                    if (i > index && x?.state === 'pending') return { ...x, state: 'discarded', draft: null };
                    return x;
                })).map(x => (nextBusState && x.state === 'pending' && x.draft
                    ? { ...x, draft: { ...x.draft, busState: nextBusState } }
                    : x));
                const updated = await store.update(id, {
                    turns: nextTurns,
                    note: `（用户撤销了上一轮应用的改动：${turn.changes.map(c => c.label).join(listSeparator())}。现在是改之前的样子。）`,
                }, sOpts);
                if (sharedBus && staleProposalIds.length) {
                    sharedBus.discardEntries(staleProposalIds);
                }
                for (const staleIdx of stalePendingIndices) {
                    draftStore.deleteTurn(id, staleIdx);
                }
                if (updated && session?.id === id) session = updated;
            }
            app.toast(i18n('Undone'));
            app.reload?.();
            undone = true;
        } catch (err) {
            app.toast(i18nFormat('Could not undo: ${0}', err?.message || err), { error: true });
        } finally {
            applying.delete(id);
        }
        await refreshSessions();
        paintAll();
        app.refreshBadges?.();
        return undone;
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
        const chatKey = JSON.stringify(chatIdentity());
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
            let launchReview = null;
            const launchOwner = o.scopeOwner ? clone(o.scopeOwner) : null;
            const launchOwnerChanged = () => launchOwner && (scope !== launchOwner.scope || charAvatar() !== launchOwner.avatar);
            const rejectChangedLaunch = async () => {
                await reviews.complete(launchReview);
                app.toast(i18n('The iteration target changed before the editor opened. Select the intended target and retry.'), { error: true });
                paintAll();
            };
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
            if (hasLaunchReset && reviews.current) {
                await reviews.complete(reviews.current);
            }
            let newReview = null;
            if (typeof o.onCancelWithoutApply === 'function' || o.waitForClose) {
                if (!hasLaunchReset && reviews.current) launchReview = reviews.current;
                else launchReview = newReview = reviews.create(o);
            }
            if (version !== selectionVersion) {
                if (newReview) await reviews.complete(newReview);
                return;
            }
            if (newReview) reviews.current = newReview;
            const launchCompletion = o.waitForClose ? launchReview : null;
            if (o.sessionId) {
                const sOpts = sessionScopes.get(o.sessionId) ?? null;
                const s = store ? await store.get(o.sessionId, sOpts) : null;
                if (version !== selectionVersion) return launchCompletion?.promise;
                if (s) {
                    try {
                        restoreSessionDrafts(s);
                    } catch (err) {
                        app.toast(String(err?.message || err), { error: true });
                        await reviews.complete(launchReview);
                        return;
                    }
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
            if (version !== selectionVersion) return launchCompletion?.promise;
            fixScope();
            activeScopeKey = currentScopeKey();
            if (launchOwnerChanged()) {
                await rejectChangedLaunch();
                return;
            }
            if (newReview) newReview.owner = { ws, scope: clone(scopeOptsFor()) };
            paintAll();
            await refreshSessions();
            if (version !== selectionVersion) return launchCompletion?.promise;
            if (o.autoSend && seed) {
                await ensureWork();
                if (version !== selectionVersion) return launchCompletion?.promise;
                if (launchOwnerChanged()) {
                    await rejectChangedLaunch();
                    return;
                }
                const sending = send({ promptText: seed, hideFromUi: Boolean(o.hideSeedFromUi), context: o.iterationContext });
                if (launchCompletion) await Promise.race([sending, launchCompletion.promise]);
                else await sending;
            } else if (seed || o.draft) {
                input.value = seed || o.draft;
                grow();
            }
            requestAnimationFrame(() => input.focus({ preventScroll: true }));
            return launchCompletion?.promise;
        },
        onSnapshot() {
            evictStaleWork();
            if (!isVisible()) {
                const nextKey = currentScopeKey();
                if (activeScopeKey && nextKey !== activeScopeKey) {
                    void reviews.complete();
                    activeScopeKey = '';
                    loadedSessionsScopeKey = '';
                    selectionVersion++;
                    session = null;
                    recentSessions = [];
                    loadError = '';
                }
                return;
            }
            const ver = ++snapshotVersion;
            refreshScopes().then(() => {
                if (ver !== snapshotVersion || !isVisible()) return;
                fixScope();
                const nextKey = currentScopeKey();
                const scopeChanged = nextKey !== activeScopeKey;
                if (scopeChanged) {
                    void reviews.complete();
                    activeScopeKey = nextKey;
                    loadedSessionsScopeKey = '';
                    selectionVersion++;
                    session = null;
                    recentSessions = [];
                    loadError = '';
                }
                if (!currentBusy()) {
                    if (scopeChanged) paintAll();
                    else {
                        paintHead();
                        paintBody();
                        paintPreview();
                    }
                }
                if (scopeChanged || loadedSessionsScopeKey !== nextKey) {
                    void refreshSessions();
                }
            });
        },
        onRegistryUpdate() {
            if (!isVisible()) {
                loadedSessionsScopeKey = '';
                return;
            }
            const ver = ++snapshotVersion;
            refreshScopes().then(() => {
                if (ver !== snapshotVersion || !isVisible()) return;
                fixScope();
                activeScopeKey = currentScopeKey();
                loadedSessionsScopeKey = '';
                paintAll();
                void refreshSessions();
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
            loadedSessionsScopeKey = '';
            return reviews.complete();
        },
        destroy() {
            detachDiffOverlay();
            attachmentTray.destroy();
            for (const run of activeRuns.values()) run.abort?.abort();
            activeRuns.clear();
            pendingSessions.clear();
            return reviews.complete();
        },
    };
}
