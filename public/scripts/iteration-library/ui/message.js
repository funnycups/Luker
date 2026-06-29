import { renderToolCallChip } from './toolcall.js';
import { STR } from './strings.js';

/**
 * @param {Object} message - Persisted iter message
 * @param {string} message.role - 'user' | 'assistant' | 'system'
 * @param {string} message.content
 * @param {Array}  [message.toolCalls]
 * @param {Array}  [message.toolResults]  read-tool results, shape: { tool_call_id, content, status? }
 * @param {Array}  [message.edits]
 * @param {number} [message.appliedAt]
 * @param {string} [message.appliedTarget]  'character' | 'global' | display label
 * @param {number} [message.rolledBackAt]
 * @param {boolean} [message.auto]
 * @param {string} [message.id]
 * @param {Object} opts
 * @param {Object} opts.toolDisplay              tool-name → { icon, label, type, summarize }
 * @param {Function} opts.renderEditCard         (edit, message) => html. The `message` arg
 *                                               is the assistant turn the edit belongs to —
 *                                               popups use it to gate the "pass live snapshot
 *                                               to renderDiffCard" path on whether the turn
 *                                               is still pending vs. already applied.
 * @param {Function} [opts.renderApplyControls]  (message) => html. Rendered between
 *                                               the edit cards and the regen row. Popups
 *                                               typically wire `renderApplyControls`
 *                                               from `iteration-library/ui/apply.js`.
 *                                               When omitted, message turns with edits
 *                                               do not render Apply/Reject affordances
 *                                               (suitable for read-only renders or tests).
 * @param {boolean} opts.isLast                  true when this assistant is the LAST ASSISTANT turn
 *                                               in the visible message list — i.e. no later message
 *                                               has role === 'assistant'. Caller must skip trailing
 *                                               user/system/auto messages when computing this.
 *                                               Drives Regenerate visibility (last assistant cannot
 *                                               regenerate because re-sending recomputes from the
 *                                               same prompt anyway).
 * @param {Function} opts.i18n                   (template, ...args) => string. Templates use
 *                                               `${0}` / `${1}` positional placeholders. The caller
 *                                               supplies a function that both translates and
 *                                               interpolates so word order can vary across locales.
 * @param {Function} [opts.renderMarkdown]       (text) => sanitized html. Falls back to escape + <br>.
 * @param {string} [opts.actionAttribute]        e.g. 'data-cpa-it-action'; defaults to 'data-luker-lib-action'
 * @returns {string} HTML
 */
export function renderMessageCard(message, opts = {}) {
    if (!message) return '';
    const role = String(message.role || 'user');
    const i18n = typeof opts.i18n === 'function' ? opts.i18n : (s) => String(s ?? '');
    const renderMd = typeof opts.renderMarkdown === 'function' ? opts.renderMarkdown : null;
    const actionAttr = opts.actionAttribute || 'data-luker-lib-action';
    const msgId = String(message.id || '');

    if (role === 'system') {
        const sysBody = renderMd
            ? renderMd(String(message.content || ''))
            : `<em>${escapeHtml(String(message.content || ''))}</em>`;
        return `<div class="luker_lib_message luker_lib_message_system" data-luker-lib-msg-id="${escapeHtmlAttr(msgId)}">
            ${sysBody}
        </div>`;
    }
    if (role === 'user') {
        // Auto-continue user messages are internal plumbing — they carry
        // an LLM-facing nudge ("Continue with the next iteration step.
        // Call luker_*_finalize_iteration once …") that the user should
        // never see in the chat. The loop's progression is already
        // visible as the next assistant turn.
        if (message.auto) return '';
        const cls = 'luker_lib_message luker_lib_message_user';
        const body = escapeHtml(String(message.content || '')).replace(/\n/g, '<br>');
        // Edit affordance: clicking pulls the message text back into the
        // composer textarea, truncates the chat to just before this turn,
        // and rolls back every commit those discarded turns made. The
        // composer stays editable so the user can adjust before resending
        // (sending then re-fires the normal send pipeline). Without the
        // rollback step, edit-and-resend would regenerate against a disk
        // state already polluted by the prior round's commits.
        const editBtn = `<button class="luker_lib_message_user_edit menu_button menu_button_small" ${actionAttr}="edit-user-message" data-luker-lib-msg-id="${escapeHtmlAttr(msgId)}" title="${escapeHtmlAttr(i18n('Edit and regenerate from here'))}">${escapeHtml(i18n('Edit'))}</button>`;
        return `<div class="${cls}" data-luker-lib-msg-id="${escapeHtmlAttr(msgId)}">${body}${editBtn}</div>`;
    }

    // assistant
    const content = String(message.content || '');
    const bodyHtml = renderMd ? renderMd(content) : escapeHtml(content).replace(/\n/g, '<br>');

    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    const toolResults = Array.isArray(message.toolResults) ? message.toolResults : [];
    const resultById = new Map();
    for (const r of toolResults) {
        if (r && r.tool_call_id != null) resultById.set(String(r.tool_call_id), r);
    }
    const edits = Array.isArray(message.edits) ? message.edits : [];

    // Empty-card guard: if an assistant turn carries nothing renderable
    // (no content, no tools, no edits, not applied / rolled back) then
    // skip the bordered wrapper entirely — otherwise the user sees a
    // floating empty card that suggests "something is here" when nothing
    // is. Status / regen affordances still need to trigger a render even
    // when content + tools + edits are all empty (e.g. an old assistant
    // turn whose tools were stripped on regen).
    const hasContent = content.length > 0;
    const hasTools = toolCalls.length > 0 || toolResults.length > 0;
    const hasEdits = edits.length > 0;
    const hasStatus = Boolean(message.appliedAt) || Boolean(message.rolledBackAt);
    if (!hasContent && !hasTools && !hasEdits && !hasStatus) {
        return '';
    }

    const toolDisplay = opts.toolDisplay || {};
    const toolsHtml = toolCalls.map(tc => {
        const result = resultById.get(String(tc?.id || ''));
        return renderToolCallChip(tc, {
            toolDisplay,
            result: result ? result.content : undefined,
            status: result ? (result.status || 'ok') : 'ok',
            i18n,
        });
    }).join('');

    const renderEdit = typeof opts.renderEditCard === 'function' ? opts.renderEditCard : () => '';
    const editsHtml = edits.map(e => renderEdit(e, message)).join('');

    // Read-only round hint: assistant message with content empty AND every tool call is read AND no edits AND not finalized
    const allRead = toolCalls.length > 0
        && edits.length === 0
        && toolCalls.every(tc => toolDisplay[String(tc?.name || '')]?.type === 'read');
    const readOnlyHint = allRead
        ? `<div class="luker_lib_message_readonly_hint">${escapeHtml(i18n('AI read the indicated data and is waiting to act on the result next round.'))}</div>`
        : '';

    const applied = Boolean(message.appliedAt) && !message.rolledBackAt;
    const rolledBack = Boolean(message.rolledBackAt);

    // Apply / Rollback / Rolled-back row. Popups wire renderApplyControls
    // from iteration-library/ui/apply.js — that helper handles all three
    // states (pending edits → Apply+Reject; applied → status + Rollback
    // button; rolled back → muted status). When the hook is omitted, the
    // message renders without any apply affordance.
    const applyControlsHtml = typeof opts.renderApplyControls === 'function'
        ? opts.renderApplyControls(message)
        : '';

    const showRegen = !opts.isLast && !message.auto;
    const regenHtml = showRegen
        ? `<div class="luker_lib_message_actions">
            <button class="menu_button menu_button_small" ${actionAttr}="regenerate" data-luker-lib-msg-id="${escapeHtmlAttr(msgId)}">
                ${escapeHtml(i18n('Regenerate'))}
            </button>
        </div>`
        : '';

    return `<div class="luker_lib_message luker_lib_message_assistant" data-luker-lib-msg-id="${escapeHtmlAttr(msgId)}">
        ${bodyHtml}
        ${readOnlyHint}
        ${toolsHtml}
        ${editsHtml}
        ${applyControlsHtml}
        ${regenHtml}
    </div>`;
}

function formatTime(ts) {
    try {
        const d = new Date(Number(ts) || Date.now());
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch { return ''; }
}

function escapeHtml(s) {
    // Same narrowing as toolcall.js: only & < > escaped. Quotes can appear in
    // text-content positions because we never interpolate user-controlled values
    // into attribute positions without going through `escapeHtmlAttr`.
    return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Wider escape for attribute interpolation (msg-id, data-attrs, etc.) so
// any user-controlled string that ends up in an HTML attribute position
// can't break out of the attribute.
function escapeHtmlAttr(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
    }[c]));
}

/**
 * Listen for the bus's `bus:chain-broken` event and lock the message
 * host's input area. Once the underlying target has drifted in a way
 * the bus can no longer chain off, the session's prior proposals cannot
 * be safely re-derived; we disable the composer and surface a banner so
 * the user knows to start a fresh session.
 *
 * The popup wires this once at mount: pass the popup root, the bus
 * created for the popup, and an optional translator. Returns an unbind
 * function the popup can call at teardown.
 *
 * @param {Element} root  The popup root. Must expose `[data-iter-input]`
 *                        if input disabling is desired.
 * @param {Object} bus    A ProposalBus with `bus.events` (EventTarget).
 * @param {Object} [opts]
 * @param {Function} [opts.translate]  Translator. Defaults to identity.
 * @returns {Function} Unbind function (idempotent).
 */
export function bindChainBrokenBanner(root, bus, opts = {}) {
    if (!root || !bus || !bus.events || typeof bus.events.addEventListener !== 'function') {
        return () => {};
    }
    const t = typeof opts.translate === 'function' ? opts.translate : (s) => String(s ?? '');
    let installed = false;
    const handler = () => {
        if (installed) return;
        installed = true;
        try {
            const input = root.querySelector ? root.querySelector('[data-iter-input]') : null;
            if (input) input.disabled = true;
        } catch { /* tolerate stub roots */ }
        try {
            const banner = root.ownerDocument
                ? root.ownerDocument.createElement('div')
                : (typeof document !== 'undefined' ? document.createElement('div') : null);
            if (banner) {
                banner.className = 'iter-chain-broken-banner';
                banner.textContent = t(STR.chainBroken_generic);
                if (typeof root.appendChild === 'function') root.appendChild(banner);
            }
        } catch { /* best-effort */ }
    };
    bus.events.addEventListener('bus:chain-broken', handler);
    return () => {
        try { bus.events.removeEventListener('bus:chain-broken', handler); } catch { /* ignore */ }
    };
}
