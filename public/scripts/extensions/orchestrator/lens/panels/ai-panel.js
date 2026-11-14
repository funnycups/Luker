// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI assistant and AI diagnosis side panel. The AI edits its own copy of the
// profile (starting from the draft); each user turn ends with a field-level
// change list the user applies into the draft (or auto-apply). Nothing is
// saved until the topbar's Save. A diagnosis session starts from one recorded run (or one
// step of it) and may end with proposed fixes the same way.

import { h, clear, put, formatTime } from '../../../lens-shared/util.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat, dateLocale, agentName } from '../i18n.js';
import { button, iconButton, checkRow, isTouch } from '../ui/components.js';
import { runTurn, newSession, sessionTitle, upsertSession, toolCallText, isEditTool, markEdits, makeId, toolSet, systemPrompt, runSteps, diagnoseMessage, statsMessage } from '../model/ai.js';
import { diffProfiles } from '../model/edit.js';
import { targetKey } from '../model/drafts.js';
import { changeList } from './change-list.js';

const SUGGESTIONS = [
    i18n('Check whether agent responsibilities overlap or leave gaps'),
    i18n('Make the review stricter about character voice'),
    i18n('Make the prompts more concise and remove repeated requirements'),
];
const ROLLED_BACK = { status: 'rolled_back', message: 'The user undid this edit; the working draft no longer contains it.' };
const DISCARDED = { status: 'rejected', message: 'The user did not apply this edit; the working draft does not contain it.' };
const AUTO_KEY = 'orchestraLens.aiAutoApply';

/**
 * @param {object} app  lens app (drafts, snapshot, recorder, notify, …)
 * @param {{ onClose(): void, openSettings(): void }} host
 */
export function createAiPanel(app, host) {
    const access = app.source.ai;
    const log = h('div', { class: 'ol-ai-log', role: 'log', 'aria-live': 'polite' });
    const context = h('div', { class: 'ol-ai-context', hidden: true });
    const input = h('textarea', {
        class: 'ol-ai-input',
        rows: 1,
        placeholder: i18n('How should orchestration change? For example, "stop the reviewer from sending back small issues"'),
        'aria-label': i18n('Request for the AI'),
        onInput: () => fit(),
        onKeydown: (event) => {
            event.stopPropagation();
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !isTouch()) {
                event.preventDefault();
                send();
            }
        },
    });
    const sendBtn = h('button', { type: 'button', class: 'ol-ai-send', onClick: () => (busy ? stop() : send()) });
    const historyBox = h('div', { class: 'ol-ai-history', hidden: true });
    const titleEl = h('span', { class: 'ol-ai-title', text: i18n('AI assistant') });
    let autoApply = readAuto();
    const el = h('aside', { class: 'ol-ai', 'aria-label': i18n('AI assistant') },
        h('header', { class: 'ol-ai-head' },
            h('span', { class: 'ol-ai-mark', 'aria-hidden': 'true' }, icon('sparkle', { size: 15 })),
            titleEl,
            h('span', { class: 'ol-spacer' }),
            iconButton('gear', i18n('Model used by the AI'), () => host.openSettings(), { className: 'ol-iconbtn-sm' }),
            iconButton('clock', i18n('Conversations'), () => toggleHistory(), { className: 'ol-iconbtn-sm' }),
            iconButton('plus', i18n('New conversation'), () => startNew(), { className: 'ol-iconbtn-sm' }),
            iconButton('x', i18n('Close'), () => host.onClose(), { className: 'ol-iconbtn-sm' })),
        historyBox, context, log,
        h('div', { class: 'ol-ai-compose' }, input, sendBtn),
        h('div', { class: 'ol-ai-foot' },
            checkRow({
                checked: autoApply,
                label: i18n('Apply automatically'),
                note: i18n('AI edits go straight into the draft (still need saving)'),
                className: 'ol-ai-auto',
                onChange: (value) => {
                    autoApply = value;
                    try { localStorage.setItem(AUTO_KEY, value ? '1' : '0'); } catch { /* ignore */ }
                },
            }),
            isTouch() ? null : h('span', { class: 'ol-ai-keys', text: i18n('Enter to send · Shift+Enter for a new line') })));

    let status = 'idle'; // idle | ready
    let scope = '';
    let sessions = [];
    let session = newSession();
    let busy = false;
    let controller = null;
    let aiLive = null; // the AI's working copy (may be ahead of the draft)
    const turns = new Map(); // user msg id → turn
    let options = null;

    function fit() {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight + 2, 160)}px`;
    }

    const mode = () => app.drafts.target()?.mode || app.snapshot()?.mode || 'spec';
    const editable = () => app.canEdit();

    async function init() {
        options = await app.source.edit?.options?.().catch(() => null) || null;
        status = 'ready';
        if (scope && status === 'ready') sessions = access.listSessions(scope);
        syncScope();
        paint();
    }

    /** Sessions are kept per preset (target). */
    function syncScope() {
        const key = targetKey(app.drafts.target() || app.snapshot()?.target);
        if (key === scope) return;
        const first = !scope; // first load: keep a session opened before data arrived
        scope = key;
        sessions = key && status === 'ready' ? access.listSessions(key) : [];
        if (!busy && !first) {
            session = newSession();
            turns.clear();
            aiLive = null;
        }
    }

    // ----- Diagnosis context ------------------------------------------------

    function runFor(key) {
        if (!key) return null;
        const raw = app.recorder.history().find(item => app.runKey(item) === key) || app.recorder.currents().find(item => app.runKey(item) === key);
        return raw || null;
    }

    function diagnosisContext() {
        if (session.kind !== 'diagnose') return null;
        const raw = runFor(session.runKey);
        if (!raw) return { missing: true };
        const view = app.runViewOf(raw);
        return { raw, view, steps: runSteps(view) };
    }

    const isDiag = () => session.kind === 'diagnose' || session.kind === 'stats';

    function paintContext() {
        clear(context);
        context.hidden = !isDiag();
        titleEl.textContent = isDiag() ? i18n('AI diagnosis') : i18n('AI assistant');
        if (context.hidden) return;
        if (session.kind === 'stats') {
            const st = session.statsCtx;
            put(context, icon('timeline', { size: 13 }),
                h('span', { class: 'ol-ai-context-text', text: st ? `${i18nFormat('Stats · last ${0} runs', st.stats.runs)}${st.focus ? ` · ${i18nFormat('"${0}"', agentName(st.focus))}` : ''}` : i18n('Stats') }),
                button(i18n('View'), () => app.setState({ view: 'stats' }), { className: 'ol-btn-sm ol-btn-ghost' }));
            return;
        }
        const ctx = diagnosisContext();
        const raw = ctx?.raw;
        const step = session.step && ctx?.steps?.[session.step - 1];
        put(context,
            icon('target', { size: 13 }),
            h('span', { class: 'ol-ai-context-text', text: ctx?.missing ? i18n('The record of this run has been cleared') : `${i18nFormat('Run at ${0}', raw?.startedAtWall ? formatTime(raw.startedAtWall).slice(0, 5) : '')}${raw?.floor > 0 ? ` · #${raw.floor}` : ''}${step ? ` · ${i18nFormat('Step ${0} "${1}"', session.step, agentName(step.agentId))}` : ''}` }),
            raw ? button(i18n('View'), () => app.openRun(session.runKey), { className: 'ol-btn-sm ol-btn-ghost' }) : null);
    }

    // ----- Rendering ----------------------------------------------------------

    // In a stats session the numbered items are evidence (E1…), not run steps.
    function readText(call) {
        if (session.kind === 'stats' && call.name === 'olens_read_step') {
            const e = session.statsCtx?.evidence?.[Number(call.args?.step) - 1];
            return e ? i18nFormat('View the ${1} of "${0}"', agentName(e.agentId), e.label) : i18nFormat('View evidence E${0}', call.args?.step);
        }
        return toolCallText(call);
    }

    function paintSend() {
        clear(sendBtn);
        sendBtn.setAttribute('aria-label', busy ? i18n('Stop run') : i18n('Send'));
        sendBtn.title = busy ? i18n('Stop run') : i18n('Send');
        sendBtn.classList.toggle('is-busy', busy);
        put(sendBtn, icon(busy ? 'stop' : 'arrowUp', { size: 15 }));
        sendBtn.disabled = status !== 'ready';
        input.disabled = status !== 'ready';
        input.placeholder = isDiag() && !session.messages.length
            ? (session.kind === 'stats' ? i18n('What should it focus on? (optional, you can just send)') : i18n('What is wrong? (optional, send to let the AI find out)'))
            : isDiag() ? i18n('Ask more, or have the AI apply the diagnosis') : i18n('How should orchestration change? For example, "stop the reviewer from sending back small issues"');
    }

    function paint() {
        paintSend();
        paintContext();
        clear(log);
        if (!editable()) {
            put(log, h('div', { class: 'ol-ai-note is-warn', text: app.editBlockedReason() || i18n('The current profile cannot be edited here, so the AI can only make suggestions.') }));
        }
        if (!session.messages.length) {
            if (session.kind === 'stats') {
                const st = session.statsCtx;
                put(log, h('div', { class: 'ol-ai-empty' },
                    h('p', { class: 'ol-ai-empty-title', text: st?.focus ? i18nFormat('Diagnose "${0}"', agentName(st.focus)) : i18n('Diagnose from stats') }),
                    h('p', { class: 'ol-ai-empty-sub', text: i18nFormat('The AI reads the stats of the last ${0} runs, then goes through the failed and slowest runs of ${1} to find the cause, and proposes edits where it can.', st?.stats.runs || 0, st?.focus ? i18n('this agent') : i18n('the slowest and most error-prone agents')) }),
                    h('div', { class: 'ol-ai-suggest' }, (st?.focus ? [i18n('Why is it so slow'), i18n('Why does it fail'), i18n('Give it a faster model')] : [i18n('Make the whole thing faster'), i18n('Too many errors, see why'), i18n('Can slow agents get a faster model')]).map(text => h('button', {
                        type: 'button', class: 'ol-ai-chip', onClick: () => { input.value = text; fit(); input.focus(); },
                    }, h('span', { text })))),
                    button(i18n('Start diagnosis now'), () => send({ allowEmpty: true }), { iconName: 'sparkle', className: 'ol-btn-sm ol-btn-primary' })));
                return;
            }
            if (session.kind === 'diagnose') {
                put(log, h('div', { class: 'ol-ai-empty' },
                    h('p', { class: 'ol-ai-empty-title', text: session.step ? i18n('Diagnose this step') : i18n('Diagnose this run') }),
                    h('p', { class: 'ol-ai-empty-sub', text: i18n('The AI reads each step of this run and the final result, finds which agent caused the problem and why, and suggests changes.') }),
                    h('div', { class: 'ol-ai-suggest' }, [i18n('The reply is cold and impersonal'), i18n('Lorebook settings were not used'), i18n('It runs too slowly')].map(text => h('button', {
                        type: 'button', class: 'ol-ai-chip', onClick: () => { input.value = text; fit(); input.focus(); },
                    }, h('span', { text })))),
                    button(i18n('Start diagnosis now'), () => send({ allowEmpty: true }), { iconName: 'sparkle', className: 'ol-btn-sm ol-btn-primary' })));
                return;
            }
            put(log, h('div', { class: 'ol-ai-empty' },
                h('p', { class: 'ol-ai-empty-title', text: i18n('Adjust orchestration by talking') }),
                h('p', { class: 'ol-ai-empty-sub', text: i18n('The AI reads the current profile and edits each agent\'s role prompt, task template and model. Changes are listed for you to pick from and apply only after saving.') }),
                h('div', { class: 'ol-ai-suggest' }, SUGGESTIONS.map(text => h('button', {
                    type: 'button', class: 'ol-ai-chip', onClick: () => { input.value = text; fit(); input.focus(); },
                }, h('span', { text }))))));
            return;
        }
        for (const m of session.messages) {
            if (m.role === 'user') {
                put(log, h('div', { class: 'ol-ai-msg is-user' }, h('div', { class: 'ol-ai-bubble', text: m.display ?? m.content })));
                continue;
            }
            if (m.role === 'note') {
                put(log, h('div', { class: 'ol-ai-note', text: m.content }));
                continue;
            }
            const calls = m.toolCalls || [];
            const results = new Map((m.toolResults || []).map(r => [String(r.tool_call_id), r]));
            const reads = calls.filter(c => !isEditTool(c.name));
            const edits = calls.filter(c => isEditTool(c.name));
            put(log, h('div', { class: 'ol-ai-msg is-ai' },
                reads.length ? h('div', { class: 'ol-ai-reads', text: reads.length === 1 ? readText(reads[0]) : i18nFormat('Looked up ${0} references', reads.length) }) : null,
                edits.length ? h('ul', { class: 'ol-ai-tools' }, edits.map(c => {
                    const r = results.get(String(c.id));
                    const noop = r?.content?.status === 'noop';
                    const failed = r?.status === 'fail' && !noop;
                    return h('li', { class: failed || noop ? 'is-fail' : '' }, icon(failed ? 'alert' : 'pen', { size: 12 }), h('span', { text: noop ? i18nFormat('${0} (no change)', toolCallText(c)) : failed ? i18nFormat('${0} (failed; the AI will retry)', toolCallText(c)) : toolCallText(c) }));
                })) : null,
                m.content ? h('div', { class: 'ol-ai-text', text: m.content }) : null));
            const turn = [...turns.values()].find(x => x.endId === m.id);
            if (turn) put(log, turnCard(turn));
        }
        if (busy) put(log, h('div', { class: 'ol-ai-thinking' }, h('span', { class: 'ol-spinner', 'aria-hidden': 'true' }), h('span', { text: isDiag() ? i18n('Analyzing…') : i18n('Thinking…') })));
        requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    }

    function turnCard(turn) {
        if (!turn.changes.length) return null;
        // A field the user changed by hand after the AI finished can't be applied blindly.
        const stale = new Set(turn.state === 'pending'
            ? turn.changes.filter(c => app.drafts.get(c.agentId, c.field) !== turn.draftAtEnd[c.id]).map(c => c.id)
            : []);
        return changeList({
            changes: turn.changes,
            state: editable() ? turn.state : 'review',
            applied: turn.applied,
            stale,
            onApply: (chosen) => applyTurn(turn, chosen),
            onDiscard: () => discardTurn(turn),
            onUndo: turn.state === 'applied' ? () => undoTurn(turn) : null,
            onFocus: (change) => app.focusField(change.agentId, change.field),
        });
    }

    // ----- Turns --------------------------------------------------------------

    function applyTurn(turn, chosen) {
        turn.before = app.drafts.applyMany(chosen.map(c => ({ agentId: c.agentId, field: c.field, after: c.after })), { by: 'ai' });
        turn.applied = new Set(chosen.map(c => c.id));
        turn.state = 'applied';
        if (chosen.length < turn.changes.length) {
            const skipped = turn.changes.filter(c => !turn.applied.has(c.id)).map(c => `${c.agentId}.${c.field}`);
            markEdits(session.messages, turn.ids, { status: 'partially_applied', message: `The user applied only some edits. Not applied: ${skipped.join(', ')}. Re-read before further edits.` });
            session.messages.push({ id: makeId('msg'), role: 'note', content: i18nFormat('Applied ${0} of ${1}', chosen.length, turn.changes.length), at: Date.now() });
        }
        aiLive = null;
        persist();
        paint();
    }

    function discardTurn(turn) {
        turn.state = 'discarded';
        markEdits(session.messages, turn.ids, DISCARDED);
        aiLive = null;
        persist();
        paint();
    }

    function undoTurn(turn) {
        const order = (x) => session.messages.findIndex(m => m.id === x.endId);
        const later = [...turns.values()].filter(x => x.state === 'applied' && order(x) > order(turn));
        for (const x of [turn, ...later]) x.state = 'undone';
        app.drafts.restore(turn.before);
        aiLive = null;
        markEdits(session.messages, [turn, ...later].flatMap(x => x.ids), ROLLED_BACK);
        session.messages.push({ id: makeId('msg'), role: 'note', content: later.length ? i18nFormat('Undid the last ${0} rounds of edits', later.length + 1) : i18n('This round of edits was undone'), at: Date.now() });
        persist();
        paint();
    }

    async function send({ allowEmpty = false } = {}) {
        const text = input.value.trim();
        if ((!text && !(allowEmpty || (isDiag() && !session.messages.length))) || busy || status !== 'ready') return;
        syncScope();
        const diag = diagnosisContext();
        if (session.kind === 'diagnose' && diag?.missing) {
            app.notify(i18n('The record of this run has been cleared, so it cannot be diagnosed'), { error: true });
            return;
        }
        input.value = '';
        fit();
        const first = !session.messages.length;
        const userMsg = { id: makeId('msg'), role: 'user', content: text, at: Date.now() };
        if (session.kind === 'diagnose' && first) {
            userMsg.content = diagnoseMessage({ view: diag.view, steps: diag.steps, reply: access.replyFor?.(diag.raw) || '', focusStep: session.step || 0, complaint: text });
            userMsg.display = text ? i18nFormat('Diagnose: ${0}', text) : (session.step ? i18n('Diagnose this step') : i18n('Diagnose this run'));
        }
        const st = session.statsCtx;
        if (session.kind === 'stats' && first) {
            userMsg.content = statsMessage({ stats: st.stats, evidence: st.evidence, mode: st.mode, focus: st.focus, complaint: text });
            userMsg.display = text ? i18nFormat('Stats diagnosis: ${0}', text) : (st.focus ? i18nFormat('Diagnose "${0}"', agentName(st.focus)) : i18n('Diagnose from stats'));
        }
        if (first) {
            session.title = session.kind === 'stats' ? i18nFormat('Stats diagnosis · ${0}', text || (st.focus ? agentName(st.focus) : i18n('Overall')))
                : session.kind === 'diagnose' ? i18nFormat('Diagnosis · ${0}', text || (session.step ? i18nFormat('Step ${0}', session.step) : i18n('this run'))) : sessionTitle(text);
        }
        session.messages.push(userMsg);
        busy = true;
        controller = new AbortController();
        paint();
        const firstAi = session.messages.length;
        const pending = [...turns.values()].some(x => x.state === 'pending');
        const startCopy = pending && aiLive ? aiLive : app.drafts.profile();
        const m = mode();
        try {
            const out = await runTurn((args) => access.request(args), session, {
                mode: m,
                profile: startCopy,
                system: (live) => systemPrompt({ mode: m, profile: live, options, diagnose: session.kind === 'stats' ? 'stats' : session.kind === 'diagnose' }),
                tools: toolSet({ withRun: isDiag() }),
                steps: session.kind === 'stats' ? (st?.evidence || []) : (diag?.steps || []),
                options,
                signal: controller.signal,
                onUpdate: () => paint(),
            });
            aiLive = out.profile;
            const endId = session.messages[session.messages.length - 1]?.id;
            const ids = session.messages.slice(firstAi).map(x => x.id);
            const changes = diffProfiles(m, app.drafts.profile(), out.profile);
            for (const x of turns.values()) if (x.state === 'pending') x.state = 'superseded';
            if (changes.length) {
                const draftAtEnd = Object.fromEntries(changes.map(c => [c.id, app.drafts.get(c.agentId, c.field)]));
                const turn = { endId, ids, changes, state: 'pending', applied: new Set(), draftAtEnd, before: null };
                turns.set(userMsg.id, turn);
                if (autoApply && editable()) applyTurn(turn, changes);
            }
        } catch (err) {
            const aborted = err?.name === 'AbortError' || controller?.signal.aborted;
            session.messages.push({ id: makeId('msg'), role: 'note', content: aborted ? i18n('Stopped') : i18nFormat('AI call failed: ${0}', String(err?.message || err)), at: Date.now() });
        } finally {
            busy = false;
            controller = null;
            persist();
            paint();
        }
    }

    function stop() {
        controller?.abort();
    }

    function persist() {
        if (!scope) return;
        const stored = { ...session, messages: session.messages.filter(x => x.role !== 'note') };
        // Evidence bodies can be long; keep enough for a resumed chat to re-read.
        if (stored.statsCtx) stored.statsCtx = { ...stored.statsCtx, evidence: stored.statsCtx.evidence.map(e => ({ ...e, full: e.full.slice(0, 8000) })) };
        sessions = upsertSession(sessions, stored);
        try { access.saveSessions(scope, sessions); } catch { /* best effort */ }
    }

    function startNew(kind = 'chat', extra = {}) {
        if (busy) return false;
        session = { ...newSession(kind), ...extra };
        turns.clear();
        aiLive = null;
        historyBox.hidden = true;
        paint();
        input.focus();
        return true;
    }

    function toggleHistory() {
        historyBox.hidden = !historyBox.hidden;
        if (historyBox.hidden) return;
        clear(historyBox);
        if (!sessions.length) {
            put(historyBox, h('p', { class: 'ol-ai-history-empty', text: i18n('This profile has no conversations yet.') }));
            return;
        }
        put(historyBox, h('ul', null, sessions.map(s => h('li', null,
            h('button', {
                type: 'button',
                class: `ol-ai-history-item${s.id === session.id ? ' is-current' : ''}`,
                onClick: () => {
                    if (busy) return;
                    session = JSON.parse(JSON.stringify(s));
                    turns.clear();
                    aiLive = null;
                    historyBox.hidden = true;
                    paint();
                },
            },
            s.kind === 'stats' ? icon('timeline', { size: 12 }) : s.kind === 'diagnose' ? icon('target', { size: 12 }) : icon('sparkle', { size: 12 }),
            h('span', { class: 'ol-ai-history-title', text: s.title || i18n('Untitled conversation') }),
            h('span', { class: 'ol-ai-history-meta', text: new Date(s.at).toLocaleString(dateLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })),
            iconButton('trash', i18n('Delete this record'), () => {
                sessions = sessions.filter(x => x.id !== s.id);
                try { access.saveSessions(scope, sessions); } catch { /* ignore */ }
                if (s.id === session.id) startNew();
                else { historyBox.hidden = true; toggleHistory(); }
            }, { className: 'ol-iconbtn-sm' })))));
    }

    init();
    return {
        el,
        isBusy: () => busy,
        focus: () => requestAnimationFrame(() => input.focus()),
        /** Opens a chat with a prefilled request. */
        ask(text = '') {
            syncScope();
            if (isDiag() || session.messages.length > 6) startNew('chat');
            if (text) { input.value = text; fit(); }
            paint();
            requestAnimationFrame(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
        },
        /** Starts a diagnosis session for one run (optionally one step). */
        diagnose(runKey, step = 0) {
            syncScope();
            if (!startNew('diagnose', { runKey, step: Number(step) || 0 })) app.notify(i18n('The AI is replying, please wait'), { error: true });
        },
        /** Starts a diagnosis from the stats view. `ctx` = { stats, evidence, mode, focus }, frozen into the session. */
        diagnoseStats(ctx) {
            syncScope();
            if (!startNew('stats', { statsCtx: ctx })) app.notify(i18n('The AI is replying, please wait'), { error: true });
        },
        /** Profile / target changed (reload, chat switch). */
        refresh() {
            syncScope();
            if (status === 'ready') paint();
        },
        destroy() { controller?.abort(); },
    };
}

function readAuto() {
    try { return localStorage.getItem(AUTO_KEY) === '1'; } catch { return false; }
}
