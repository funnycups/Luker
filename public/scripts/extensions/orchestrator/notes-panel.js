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
 * KNOWN LIMITATION (follow-up): the `fs` adapter is captured at mount
 * time. When the user switches chats (CHAT_CHANGED), we re-render but
 * do NOT re-attach the floor-state, so the panel may show notes from
 * the previous chat until the page is reloaded. Re-attach on chat
 * change can be a follow-up if it becomes a problem in practice.
 *
 * UX note: `window.prompt` / `window.confirm` are placeholders for the
 * close-reason input and delete confirmation. A more polished
 * SillyTavern Popup-based UX can replace these in a follow-up task.
 */

import { NOTES_PANEL_TEMPLATE } from './ui-templates.js';
import { attachNotesFloorState } from './loop-runtime.js';

const MODULE_NAME = 'orchestrator';

export async function mountNotesPanel(host, context) {
    if (!host || host.dataset.luker_notes_mounted === '1') return;
    host.dataset.luker_notes_mounted = '1';
    host.insertAdjacentHTML('beforeend', NOTES_PANEL_TEMPLATE);

    const adapterCtx = {};
    await attachNotesFloorState(adapterCtx);
    const fs = adapterCtx.__floorStateForNotes;
    if (!fs) {
        const list = host.querySelector('#luker-notes-list');
        if (list) list.innerHTML = '<li class="luker-notes-empty" data-i18n="No open notes yet">No open notes yet</li>';
        return;
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
        if (action === 'close') {
            const reason = (window.prompt('Closure reason (optional)') || '').trim();
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
            if (!window.confirm('Confirm delete (permanent)?')) return;
            await fs.deleteByIds([entry.id]);
            await rerender();
        }
    }

    // Subscribe to floor-state settle for live update.
    // NOTE: this rerender uses the stale `fs` reference from mount time —
    // it will show the previous chat's notes after CHAT_CHANGED. Acceptable
    // for now; re-attach on chat change is a follow-up.
    if (typeof context?.eventSource?.on === 'function' && context?.eventTypes?.CHAT_CHANGED) {
        context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => { void rerender(); });
    }

    await rerender();
}
