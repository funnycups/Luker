// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

/**
 * User-facing Notes panel for the orchestrator extension drawer.
 *
 * Mounts inside the second inline-drawer of the orchestrator settings
 * container (see `ui-templates.js` → `buildOrchestratorSettingsHtml`).
 * Renders the `NOTES_PANEL_TEMPLATE` from `ui-templates.js`, attaches a
 * floor-state adapter via `attachNotesFloorState`, and wires up the
 * Open/Closed tab switcher plus the per-row Close / Edit / Delete
 * actions.
 *
 * The floor-state adapter is re-attached on `CHAT_CHANGED` so the panel
 * always reflects the active chat's notes — without that re-attach,
 * switching chats would leave the panel rendering the previous chat's
 * floor state until reload.
 *
 * UX note: `window.prompt` / `window.confirm` are placeholders for the
 * close-reason input and delete confirmation. A SillyTavern
 * Popup-based UX can replace these later without touching this module's
 * floor-state plumbing.
 */

import { NOTES_PANEL_TEMPLATE } from './ui-templates.js';
import { attachNotesFloorState, onNotesChanged } from './loop-runtime.js';
import { i18n as t } from './i18n.js';

const MODULE_NAME = 'orchestrator';

/**
 * Localize a notes-adapter write-rejection envelope into a user-facing
 * toast. Mirrors `mapNoteReasonToToolError` in `loop-tools/note.js` (which
 * targets the LLM); this version targets the human at the keyboard, so
 * reasons that imply "the user must take action" (INSTANCE_DESTROYED,
 * REPLAY_BROKEN) tell them to reload, while the transient ones (CONFLICT,
 * HTTP_ERROR, TRANSPORT_ERROR) tell them to retry.
 *
 * `VALIDATION_TARGET` is silent (no active chat — the user can't act on
 * it; just `console.debug` so the swallow is visible to devs). Every
 * other reason raises a toast so the user knows the click did not land.
 *
 * @param {string} verb — localized infinitive verb describing the failed
 *                        operation (e.g. `t('Close')`); used to compose
 *                        the localized message.
 * @param {{reason?: string, hint?: string}} result — adapter envelope
 */
function toastReasonForUser(verb, result) {
    const reason = result?.reason || 'UNKNOWN';
    if (reason === 'VALIDATION_TARGET') {
        // No active chat to write into — the user can't act on this. Log
        // for devs so silent swallow is observable, then return.
        console.debug(`[${MODULE_NAME}/notes] ${verb} skipped (no active chat target)`);
        return;
    }
    const tpl = (() => {
        switch (reason) {
            case 'VALIDATION_ARGS':    return t('${0} failed, invalid request');
            case 'VALIDATION_COMMIT':  return t('${0} failed, floor is invalid');
            case 'INSTANCE_DESTROYED': return t('Notes storage destroyed, reload the page');
            case 'CONFLICT':           return t('${0} conflicted with another writer, try again');
            case 'HTTP_ERROR':         return t('${0} failed, server error');
            case 'TRANSPORT_ERROR':    return t('${0} failed, network error');
            case 'REPLAY_BROKEN':      return t('Notes storage broken, reload the page');
            case 'LOG_WRITE_FAILED':   return t('${0} failed to persist');
            default:                   return t('${0} failed');
        }
    })();
    const message = tpl.replace('${0}', String(verb || ''));
    toastr.error(message);
}

export async function mountNotesPanel(host, context) {
    if (!host || host.dataset.luker_notes_mounted === '1') return;
    host.dataset.luker_notes_mounted = '1';
    host.insertAdjacentHTML('beforeend', NOTES_PANEL_TEMPLATE);

    let fs = null;

    /**
     * Rebind to the active chat's floor state. Called once at mount and
     * again on every CHAT_CHANGED so a chat switch never leaves the
     * panel reading from a stale floor-state adapter.
     */
    async function reattachFloorState() {
        // Must inherit from the live extension context — attachNotesFloorState
        // reaches through to `createFloorState`, which lives on getContext().
        // A bare `{}` here would throw inside the factory, get swallowed by
        // attachNotesFloorState's try/catch, and leave fs=null forever.
        const adapterCtx = context ? Object.create(context) : {};
        try {
            await attachNotesFloorState(adapterCtx);
        } catch (err) {
            console.warn(`[${MODULE_NAME}/notes] attachNotesFloorState failed`, err);
        }
        fs = adapterCtx.__floorStateForNotes || null;
    }

    await reattachFloorState();
    if (!fs) {
        const list = host.querySelector('#luker-notes-list');
        if (list) list.innerHTML = '<li class="luker-notes-empty" data-i18n="No open notes yet">No open notes yet</li>';
        // Even without floor state on mount, still wire the CHAT_CHANGED
        // handler — when the user switches to a chat that DOES have a
        // floor state, the next event re-attaches and the panel comes
        // alive.
    }

    let currentTab = 'open';
    const tabs = host.querySelectorAll('.luker-notes-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('is-active'));
            tab.classList.add('is-active');
            currentTab = tab.dataset.tab;
            void rerender();
        });
    });

    async function rerender() {
        const list = host.querySelector('#luker-notes-list');
        if (!list) return;
        if (!fs) {
            list.innerHTML = `<li class="luker-notes-empty" data-i18n="No ${currentTab} notes yet">No ${currentTab} notes yet</li>`;
            return;
        }
        const all = await fs.listAcrossFloors();
        const filtered = (Array.isArray(all) ? all : []).filter(e => (e?.status ?? 'open') === currentTab);
        if (filtered.length === 0) {
            list.innerHTML = `<li class="luker-notes-empty" data-i18n="No ${currentTab} notes yet">No ${currentTab} notes yet</li>`;
            return;
        }
        list.innerHTML = '';
        const tmpl = host.querySelector('#luker-notes-row-template');
        for (const entry of filtered) {
            const node = tmpl.content.firstElementChild.cloneNode(true);
            node.dataset.id = entry.id;
            node.querySelector('.luker-notes-row__text').textContent = entry.text;
            const reasonEl = node.querySelector('.luker-notes-row__reason');
            if (entry.status === 'closed' && entry.closure_reason) {
                reasonEl.textContent = entry.closure_reason;
                reasonEl.hidden = false;
            }
            const closeBtn = node.querySelector('[data-action="close"]');
            if (entry.status !== 'open') closeBtn.hidden = true;
            node.addEventListener('click', (ev) => handleRowAction(ev, entry));
            list.appendChild(node);
        }
    }

    async function handleRowAction(ev, entry) {
        const btn = ev.target.closest('[data-action]');
        if (!btn) return;
        ev.stopPropagation();
        const action = btn.dataset.action;
        if (!fs) return;
        if (action === 'close') {
            const reason = (window.prompt(t('Closure reason (optional)')) || '').trim();
            const r = await fs.updateStatusById(entry.id, 'closed', reason);
            if (r && r.ok === false) {
                if (r.reason) {
                    // Write rejection — surface to the user so the click doesn't
                    // appear to no-op silently.
                    toastReasonForUser(t('Close'), r);
                } else {
                    // Reducer no-op (not_found / already_closed) — the row
                    // probably went stale (chat switch, sibling write). Log so
                    // devs can see it; the re-render below restores the view.
                    console.debug(`[${MODULE_NAME}/notes] close no-op: ${r.error || 'unknown'}`);
                }
            }
            await rerender();
        } else if (action === 'edit') {
            const row = btn.closest('.luker-notes-row');
            const textEl = row.querySelector('.luker-notes-row__text');
            if (textEl.contentEditable === 'true') {
                textEl.contentEditable = 'false';
                const next = textEl.textContent.trim();
                if (next && next !== entry.text) {
                    const r = await fs.updateTextById(entry.id, next);
                    if (r && r.ok === false) {
                        if (r.reason) {
                            toastReasonForUser(t('Edit'), r);
                        } else {
                            console.debug(`[${MODULE_NAME}/notes] edit no-op: ${r.error || 'unknown'}`);
                        }
                    }
                }
                await rerender();
            } else {
                textEl.contentEditable = 'true';
                textEl.focus();
            }
        } else if (action === 'delete') {
            if (!window.confirm(t('Confirm delete (permanent)?'))) return;
            const r = await fs.deleteByIds([entry.id]);
            // deleteByIds either returns the {removed, missing} manifest on
            // success OR the {ok:false, reason, hint} envelope on a write
            // rejection of a real delete. The envelope is the only failure
            // shape; an empty `removed` with a non-empty `missing` is a
            // stale-row no-op (the row vanished between render and click).
            if (r && r.ok === false && r.reason) {
                toastReasonForUser(t('Delete'), r);
            } else if (r && Array.isArray(r.missing) && r.missing.length > 0 && (!r.removed || r.removed.length === 0)) {
                console.debug(`[${MODULE_NAME}/notes] delete no-op: id missing`);
            }
            await rerender();
        }
    }

    // Re-attach floor state on chat change so the panel always reflects
    // the active chat. Without this, the panel keeps reading from the
    // floor-state captured at mount time.
    //
    // Beyond CHAT_CHANGED, also rerender on MESSAGE_SWIPED / MESSAGE_DELETED /
    // MESSAGE_EDITED: floor-state's `settle*` hooks already invalidate the
    // shared adapter cache before these events fan out, so the next
    // listAcrossFloors() will read the freshly-valid commit set — but the
    // panel only knows to call it if we hear the event. Without these,
    // swiping the active assistant turn leaves the panel showing
    // swipe-bound notes that no longer apply to the current view (and the
    // mismatch only resolves when the user touches a tab or switches chats).
    if (typeof context?.eventSource?.on === 'function') {
        const refresh = async () => {
            await reattachFloorState();
            await rerender();
        };
        const evt = context.eventTypes || {};
        for (const name of ['CHAT_CHANGED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_EDITED']) {
            if (evt[name]) context.eventSource.on(evt[name], refresh);
        }
    }

    // Subscribe to adapter-level write events so an LLM-driven note_open /
    // note_close (or any other in-process mutation) refreshes the panel
    // without waiting for the user to switch chats. The bus is module-level
    // and shared across chats — re-querying the current adapter on every
    // fire naturally renders whatever the active chat now holds.
    onNotesChanged(() => { void rerender(); });

    await rerender();
}
