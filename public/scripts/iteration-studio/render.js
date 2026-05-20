import { i18n } from './i18n.js';

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function buildShellState(adapter, session, { live, reference = null, pendingApprovalProjection = null, isBusy = false } = {}) {
    return {
        session,
        live,
        reference,
        pendingApprovalProjection,
        isBusy,
        layout: adapter.layout,
    };
}

export async function renderShell(adapter, root, session, { reference = null, pendingApprovalProjection = null, isBusy = false } = {}) {
    if (!root || !adapter || !session) return;
    const live = await adapter.live();
    const state = buildShellState(adapter, session, { live, reference, pendingApprovalProjection, isBusy });

    const chatHtml = (session.messages || []).map(m => adapter.renderMessageCard(m, state)).join('');
    root.find('[data-iter-chat]').html(chatHtml);

    if (session.pendingApproval) {
        const pendingHtml = renderPendingApprovalDefault(adapter, session, state);
        root.find('[data-iter-pending]').html(pendingHtml).show();
    } else {
        root.find('[data-iter-pending]').html('').hide();
    }

    if (typeof adapter.renderToolbarSlots === 'function') {
        const slots = adapter.renderToolbarSlots(state) || {};
        root.find('[data-iter-slot="start"]').html(String(slots.start || ''));
        root.find('[data-iter-slot="end"]').html(String(slots.end || ''));
    }

    if (adapter.layout === 'split' && typeof adapter.renderPreviewPane === 'function') {
        root.find('[data-iter-preview-pane]').html(adapter.renderPreviewPane(state));
    }

    root.find('[data-iter-status]').html(isBusy ? `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(i18n('Working...'))}` : '');
    root.find('[data-iter-action="send-or-stop"]').text(isBusy ? i18n('Stop') : i18n('Send'));
}

export async function renderHistoryList(adapter, root, sessionMeta = []) {
    if (!root || !adapter) return;
    const itemsHtml = (sessionMeta || []).map(m => adapter.renderHistoryItem(m)).join('');
    root.find('[data-iter-history]').html(`
        <div class="luker-studio-history-list">
            <div class="luker-studio-history-actions">
                <div class="menu_button menu_button_small" data-iter-action="new-session">${escapeHtml(i18n('New session'))}</div>
            </div>
            ${itemsHtml || `<div class="luker-studio-history-empty">${escapeHtml(i18n('No saved sessions'))}</div>`}
        </div>
    `);
}

export function renderReferenceSelect(adapter, root, references = [], selectedId = '') {
    if (!root || !adapter) return;
    const select = root.find('[data-iter-reference-select]');
    if (!select.length) return;
    const optsHtml = [`<option value="">${escapeHtml(i18n('(None)'))}</option>`,
        ...references.map(r => `<option value="${escapeHtml(r.id)}"${r.id === selectedId ? ' selected' : ''}>${escapeHtml(r.label)}</option>`),
    ].join('');
    select.html(optsHtml);
}

function renderPendingApprovalDefault(adapter, session, _state) {
    const pending = session.pendingApproval;
    if (!pending) return '';
    const editsHtml = (pending.proposedEdits || []).map(e => {
        const op = String(e?.op || 'unknown');
        const path = String(e?.path || '');
        const label = typeof adapter.describeTool === 'function' ? adapter.describeTool(op) : op;
        return `<li><code>${escapeHtml(label)}</code> <span class="luker-studio-pending-path">${escapeHtml(path)}</span></li>`;
    }).join('');
    return `
<div class="luker-studio-pending-card">
    <div class="luker-studio-pending-title">${escapeHtml(i18n('Pending changes'))}</div>
    <div class="luker-studio-pending-text">${escapeHtml(pending.assistantText)}</div>
    <ul class="luker-studio-pending-list">${editsHtml}</ul>
    <div class="luker-studio-pending-actions">
        <div class="menu_button" data-iter-action="approve-pending">${escapeHtml(i18n('Apply'))}</div>
        <div class="menu_button" data-iter-action="reject-pending">${escapeHtml(i18n('Reject'))}</div>
    </div>
</div>`;
}
