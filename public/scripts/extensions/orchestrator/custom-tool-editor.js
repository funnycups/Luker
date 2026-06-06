/**
 * Modal popup for creating / editing one entry of `profile.customTools[]`.
 *
 * Pure UI module — the caller resolves which profile the entry belongs to
 * (loop / spec / agenda / director, global / character scope) and passes
 * us the validation predicates plus the i18n helper. We return a clean,
 * validated entry on save, or `null` if the user cancelled.
 *
 * Validation policy (all enforced before Save closes the popup):
 *   - name matches `/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/`
 *   - name not already used by ANOTHER entry in the same profile
 *   - name not shadowing a Layer-1 builtin
 *   - parameters parses as valid JSON object
 *   - body compiles as `new AsyncFunction('args', 'ctx', body)`
 *   - simulateBody (if non-empty) compiles the same way
 *
 * The popup uses `Popup`'s `onClosing` hook to validate on Save: if any
 * check fails we surface the message inline AND return `false` to keep
 * the popup open so the user can fix the field without retyping.
 */

const __ctx = SillyTavern.getContext();
const Popup = __ctx.Popup;
const POPUP_TYPE = __ctx.POPUP_TYPE;
const POPUP_RESULT = __ctx.POPUP_RESULT;
import { escapeHtml as esc } from './html-escape.js';

const AsyncFunction = (async () => {}).constructor;
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

function buildPopupHtml(initial, t) {
    const v = initial && typeof initial === 'object' ? initial : {};
    const title = t(initial ? 'Edit custom tool' : 'Add custom tool');
    const parametersRendered = typeof v.parameters === 'string'
        ? v.parameters
        : JSON.stringify(v.parameters || { type: 'object' }, null, 2);
    return `
<div class="luker_orch_ct_editor">
    <h3 class="luker_orch_ct_title">${esc(title)}</h3>
    <div class="luker_orch_ct_warning">
        ${esc(t('Custom tool code runs with full access to your SillyTavern session. Only paste code from trusted sources.'))}
    </div>

    <label class="luker_orch_ct_field">
        <div class="luker_orch_ct_label">${esc(t('Tool name (a-z, A-Z, 0-9, _; max 64)'))}</div>
        <input type="text" class="text_pole" data-orch-ct-name value="${esc(v.name || '')}">
    </label>

    <label class="luker_orch_ct_field">
        <div class="luker_orch_ct_label">${esc(t('Display name'))}</div>
        <input type="text" class="text_pole" data-orch-ct-displayname value="${esc(v.displayName || '')}">
    </label>

    <label class="luker_orch_ct_field">
        <div class="luker_orch_ct_label">${esc(t('Description'))}</div>
        <textarea class="text_pole" rows="2" data-orch-ct-description>${esc(v.description || '')}</textarea>
    </label>

    <div class="luker_orch_ct_field">
        <div class="luker_orch_ct_label">${esc(t('Mode'))}</div>
        <label class="checkbox_label"><input type="radio" name="orch_ct_mode" value="read" ${v.mode === 'read' ? 'checked' : ''}> ${esc(t('read (no side effects)'))}</label>
        <label class="checkbox_label"><input type="radio" name="orch_ct_mode" value="write" ${v.mode !== 'read' ? 'checked' : ''}> ${esc(t('write (mutates state)'))}</label>
    </div>

    <label class="luker_orch_ct_field">
        <div class="luker_orch_ct_label">${esc(t('Parameters (OpenAI JSON Schema)'))}</div>
        <textarea class="text_pole monospace" rows="8" data-orch-ct-parameters>${esc(parametersRendered)}</textarea>
    </label>

    <label class="luker_orch_ct_field">
        <div class="luker_orch_ct_label">${esc(t('Function body (async, args + ctx available)'))}</div>
        <textarea class="text_pole monospace" rows="10" data-orch-ct-body>${esc(v.body || '')}</textarea>
    </label>

    <label class="luker_orch_ct_field">
        <div class="luker_orch_ct_label">${esc(t('Simulate body (optional, used in simulation review)'))}</div>
        <textarea class="text_pole monospace" rows="6" data-orch-ct-simulatebody>${esc(v.simulateBody || '')}</textarea>
    </label>

    <div class="luker_orch_ct_validation_msg" data-orch-ct-validation hidden></div>
</div>
    `;
}

/**
 * Read every form field out of the popup DOM and produce the candidate
 * entry. Returns the raw strings — caller validates.
 */
function readFormState(dlg) {
    const $el = $(dlg);
    return {
        name: String($el.find('[data-orch-ct-name]').val() || '').trim(),
        displayName: String($el.find('[data-orch-ct-displayname]').val() || ''),
        description: String($el.find('[data-orch-ct-description]').val() || ''),
        mode: String($el.find('input[name="orch_ct_mode"]:checked').val() || 'write'),
        parametersRaw: String($el.find('[data-orch-ct-parameters]').val() || ''),
        body: String($el.find('[data-orch-ct-body]').val() || ''),
        simulateBody: String($el.find('[data-orch-ct-simulatebody]').val() || ''),
    };
}

function showValidationError(dlg, message) {
    const $el = $(dlg);
    const $msg = $el.find('[data-orch-ct-validation]');
    if ($msg.length === 0) return;
    $msg.text(String(message || ''));
    $msg.attr('hidden', null);
    $msg.removeAttr('hidden');
}

/**
 * @param {object} opts
 * @param {object|null} opts.initial Initial values; null for create mode.
 * @param {(name: string) => boolean} opts.nameInUse Predicate — true if
 *        the name is already taken by another entry in the SAME profile.
 *        (The caller computes this excluding the entry being edited.)
 * @param {(name: string) => boolean} opts.nameConflictsBuiltin Predicate —
 *        true if the name shadows a Layer-1 builtin (loop-tools registry).
 * @param {(s: string) => string} opts.t i18n helper.
 * @returns {Promise<object|null>} Validated entry, or null on cancel.
 */
export async function openCustomToolEditor({ initial, nameInUse, nameConflictsBuiltin, t }) {
    const html = buildPopupHtml(initial, t);
    let validated = null;

    const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', {
        okButton: t('Save'),
        cancelButton: t('Cancel'),
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        onClosing: (p) => {
            // Cancel / Escape / X — let the popup close, return null upstream.
            if (p.result !== POPUP_RESULT.AFFIRMATIVE) {
                return true;
            }
            const raw = readFormState(p.dlg);
            if (!NAME_PATTERN.test(raw.name)) {
                showValidationError(p.dlg, t('Name must start with a letter and use only a-z, A-Z, 0-9, _ (max 64).'));
                return false;
            }
            if (nameInUse(raw.name)) {
                showValidationError(p.dlg, t('Name already used by another tool'));
                return false;
            }
            if (nameConflictsBuiltin(raw.name)) {
                showValidationError(p.dlg, t('Name conflicts with a builtin tool'));
                return false;
            }
            let parameters;
            try {
                parameters = raw.parametersRaw ? JSON.parse(raw.parametersRaw) : { type: 'object' };
                if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
                    throw new Error('not an object');
                }
            } catch (err) {
                showValidationError(p.dlg, `${t('Parameters must be valid JSON')}: ${err.message}`);
                return false;
            }
            try {
                // eslint-disable-next-line no-new
                new AsyncFunction('args', 'ctx', raw.body);
            } catch (err) {
                showValidationError(p.dlg, `${t('Function body has syntax error')}: ${err.message}`);
                return false;
            }
            if (raw.simulateBody) {
                try {
                    // eslint-disable-next-line no-new
                    new AsyncFunction('args', 'ctx', raw.simulateBody);
                } catch (err) {
                    showValidationError(p.dlg, `${t('Simulate body has syntax error')}: ${err.message}`);
                    return false;
                }
            }
            validated = {
                name: raw.name,
                displayName: raw.displayName,
                description: raw.description,
                mode: raw.mode === 'read' ? 'read' : 'write',
                parameters,
                body: raw.body,
                simulateBody: raw.simulateBody,
            };
            return true;
        },
    });

    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE || validated === null) {
        return null;
    }
    return validated;
}
