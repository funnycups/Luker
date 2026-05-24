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
import { attachNotesFloorState } from './loop-runtime.js';
import { i18n as t } from './i18n.js';

const MODULE_NAME = 'orchestrator';

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
        const adapterCtx = {};
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
            if (!r.ok) console.warn(`[${MODULE_NAME}/notes] close failed:`, r.error);
            await rerender();
        } else if (action === 'edit') {
            const row = btn.closest('.luker-notes-row');
            const textEl = row.querySelector('.luker-notes-row__text');
            if (textEl.contentEditable === 'true') {
                textEl.contentEditable = 'false';
                const next = textEl.textContent.trim();
                if (next && next !== entry.text) await fs.updateTextById(entry.id, next);
                await rerender();
            } else {
                textEl.contentEditable = 'true';
                textEl.focus();
            }
        } else if (action === 'delete') {
            if (!window.confirm(t('Confirm delete (permanent)?'))) return;
            await fs.deleteByIds([entry.id]);
            await rerender();
        }
    }

    // Re-attach floor state on chat change so the panel always reflects
    // the active chat. Without this, the panel keeps reading from the
    // floor-state captured at mount time.
    if (typeof context?.eventSource?.on === 'function' && context?.eventTypes?.CHAT_CHANGED) {
        context.eventSource.on(context.eventTypes.CHAT_CHANGED, async () => {
            await reattachFloorState();
            await rerender();
        });
    }

    await rerender();
}
