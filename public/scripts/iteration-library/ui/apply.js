/**
 * @param {Object} message
 * @param {Object} opts
 * @param {Function} opts.i18n               (template, ...args) => string. Templates use `${0}` / `${1}` placeholders.
 * @param {string}   [opts.applyLabel]       Override the default "Apply ${0}" label.
 * @param {string}   [opts.actionAttribute]  e.g. 'data-cpa-it-action'; defaults to 'data-luker-lib-action'
 * @returns {string} HTML
 */
export function renderApplyControls(message, opts = {}) {
    if (!message) return '';
    const i18n = typeof opts.i18n === 'function' ? opts.i18n : (s) => String(s ?? '');
    const actionAttr = opts.actionAttribute || 'data-luker-lib-action';
    const msgId = String(message.id || '');
    const edits = Array.isArray(message.edits) ? message.edits : [];
    const rolledBack = Boolean(message.rolledBackAt);
    const applied = Boolean(message.appliedAt) && !rolledBack;

    if (rolledBack) {
        return `<div class="luker_lib_apply_controls luker_lib_apply_rolledback">
            <span>${escapeHtml(i18n('Rolled back at ${0}', formatTime(message.rolledBackAt)))}</span>
        </div>`;
    }
    if (applied) {
        const target = String(message.appliedTarget || '');
        // Translate `appliedTarget` through i18n so a stored English key
        // ('preset' / 'schema' / 'character' / 'global') surfaces in the
        // user's locale at render time. Mirrors the message.js status
        // branch — both renderers honor the target identically.
        const translatedTarget = target ? i18n(target) : '';
        const appliedLine = translatedTarget
            ? i18n('✓ Applied to ${0} at ${1}', translatedTarget, formatTime(message.appliedAt))
            : i18n('✓ Applied at ${0}', formatTime(message.appliedAt));
        return `<div class="luker_lib_apply_controls luker_lib_apply_applied">
            <span>${escapeHtml(appliedLine)}</span>
            <button class="menu_button menu_button_small" ${actionAttr}="rollback-batch" data-luker-lib-msg-id="${escapeHtmlAttr(msgId)}">
                ${escapeHtml(i18n('Rollback this round'))}
            </button>
        </div>`;
    }
    if (edits.length === 0) return '';
    const applyLabel = opts.applyLabel || i18n('Apply ${0}', String(edits.length));
    return `<div class="luker_lib_apply_controls luker_lib_apply_pending">
        <button class="menu_button" ${actionAttr}="apply-batch" data-luker-lib-msg-id="${escapeHtmlAttr(msgId)}">
            ${escapeHtml(applyLabel)}
        </button>
        <button class="menu_button menu_button_small" ${actionAttr}="discard-batch" data-luker-lib-msg-id="${escapeHtmlAttr(msgId)}">
            ${escapeHtml(i18n('Discard'))}
        </button>
    </div>`;
}

function formatTime(ts) {
    try {
        const d = new Date(Number(ts) || Date.now());
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch { return ''; }
}

function escapeHtml(s) {
    // Same narrowing as toolcall.js / message.js / diff.js: only & < >.
    return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Wider escape for attribute interpolation. Mirrors the helpers in
// message.js / toolcall.js / diff.js so all four renderers escape
// attribute positions consistently.
function escapeHtmlAttr(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
    }[c]));
}
