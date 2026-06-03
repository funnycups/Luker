/**
 * Skill embed export hook (Plan 2 Unit 5).
 *
 * Wires the export-side of the embed flow into Luker's existing preset
 * export event (OAI_PRESET_EXPORT_READY). The event fires from openai.js
 * with the preset body just before download; listeners can mutate the body
 * in place to attach extra fields (Luker's regex extension uses this same
 * pattern).
 *
 * UX: if the active connection profile + preset combination has any
 * preset-scope skills, surface a yes/no confirm popup asking whether to
 * include them. On yes, attach `extensions.luker.embedded_skills_source`.
 * If no skills exist for the scope, this hook is a no-op (no spurious
 * dialog).
 *
 * Character export goes through Luker's image-card serialization, which
 * doesn't currently emit a similar event. Until a CHARACTER_EXPORT_READY
 * hook lands, character-scope skills export piggybacks on the manual
 * "Pack to embed" path in the skill manager subpanel (Unit 2).
 */

import { packAndAttachSkillsForExport } from './embed-export-helper.js';
import { getActiveConnectionProfileName } from './embed-lifecycle.js';

/**
 * Confirm-then-attach for preset export. Resolves to true if the user opted
 * in and the payload was attached, false otherwise. Errors are swallowed
 * (logged) so the download still proceeds with the original preset body.
 *
 * @param {object} opts
 * @param {object} opts.context - SillyTavern context
 * @param {object} opts.presetBody - the preset JSON being exported
 *   (mutated in place when the user opts in)
 * @param {(s:string)=>string} [opts.t]
 * @returns {Promise<boolean>}
 */
export async function maybeAttachSkillsToPresetExport({ context, presetBody, t = (s) => s } = {}) {
    if (!context || !context.skills) return false;
    if (!presetBody || typeof presetBody !== 'object') return false;

    // We need a target scope to pack from. The preset name comes from the
    // preset-manager (the preset being exported is the currently selected
    // one); the apiId is the active connection profile, per the Plan 2
    // Unit 1 labeling convention.
    const presetName = resolvePresetName(context);
    if (!presetName) return false;
    const apiId = getActiveConnectionProfileName(context) || 'openai';
    const targetScope = { kind: 'preset', apiId, name: presetName };

    // Bail early if the scope has no skills — no popup, no payload, just
    // pass through. This is the dominant case for users who don't bind
    // skills to presets.
    let list;
    try {
        list = await context.skills.list({ scope: targetScope });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[embed-export-hook] preset list failed:', e?.message || e);
        return false;
    }
    if (!Array.isArray(list) || list.length === 0) return false;

    // Ask the user. callGenericPopup returns POPUP_RESULT-shaped values;
    // we treat any truthy result as "yes". Falls back to false on missing API.
    const ok = await confirmIncludeSkills({ context, t, list, targetScope });
    if (!ok) return false;

    try {
        const payload = await packAndAttachSkillsForExport({
            context,
            targetScope,
            attachTo: presetBody,
        });
        if (payload) {
            toast(t('Bundled ${0} skill(s) with this preset.').replace('${0}', String(list.length)), 'success');
            return true;
        }
    } catch (e) {
        toast(t('Failed to bundle skills with preset: ${0}').replace('${0}', e?.message || String(e)), 'error');
    }
    return false;
}

async function confirmIncludeSkills({ context, t, list, targetScope }) {
    if (!context.callGenericPopup || !context.POPUP_TYPE) return false;
    const names = list.map(s => s?.name).filter(Boolean);
    const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
    })[c]);
    const list_html = names.map(n => `<li>${escHtml(n)}</li>`).join('');
    const scope_label = `preset: ${escHtml(targetScope.apiId)} / ${escHtml(targetScope.name)}`;
    const html = `
<div class="luker_skill_export_confirm">
    <div>${escHtml(t('Include preset-scope skills in this export?'))}</div>
    <div class="luker_skill_export_confirm_scope"><b>${scope_label}</b></div>
    <ul class="luker_skill_export_confirm_list">${list_html}</ul>
</div>
    `;
    const result = await context.callGenericPopup(html, context.POPUP_TYPE.CONFIRM, '', {
        okButton: t('Include'),
        cancelButton: t('Skip'),
    });
    return isAffirmative(result);
}

function isAffirmative(result) {
    return result === 1 || result === true;
}

/**
 * Resolve the name of the preset being exported. The export handler in
 * openai.js reads `oai_settings.preset_settings_openai` for "the currently
 * selected preset", so we mirror that. Falls back to scanning common
 * positions on the supplied body for a name field.
 *
 * @param {object} context
 * @returns {string}
 */
function resolvePresetName(context) {
    try {
        const ext = context?.extensionSettings || context?.extension_settings;
        const oai = ext?.openai || globalThis.oai_settings;
        const name = oai?.preset_settings_openai;
        if (typeof name === 'string' && name.trim()) return name.trim();
    } catch (_) { /* swallow */ }
    return '';
}

function toast(message, level) {
    if (typeof toastr === 'undefined') {
        // eslint-disable-next-line no-console
        console.warn('[embed-export-hook]', message);
        return;
    }
    if (level === 'error') toastr.error(String(message));
    else if (level === 'success') toastr.success(String(message));
    else toastr.info(String(message));
}
