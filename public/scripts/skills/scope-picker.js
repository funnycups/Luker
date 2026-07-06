/**
 * Shared scope picker for the Skill subsystem.
 *
 * Replaces the duplicated `pickTargetScope` implementations that lived
 * inline in `skill-manager-panel.js` (Move to) and `skill-editor.js`
 * (Create-new + change-scope).
 *
 * The preset-scope sub-row asks for a single thing: the chat completion
 * preset to bind to. There is no "connection profile" field, because a
 * preset is decoupled from any particular connection profile in Luker —
 * a skill bound to preset X should travel with X regardless of which
 * connection profile is currently routing requests. The runtime matches
 * preset-scope skills by preset name alone (see
 * `src/skills/scope.js#encodeScopePath` and
 * `orchestrator/skill-resolution.js#resolveAgentVisibleSkills`).
 *
 * The character-scope sub-row similarly uses a real <select> populated
 * from `context.characters`. Both sub-rows are hidden via the `hidden`
 * attribute when the user picks a different kind on the radio.
 */

import { ensureSkillI18n } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
})[c]);

/**
 * Collect every chat-completion preset known to any preset manager. Each
 * entry is `{name, api}`; `api` is informational (used for the disambiguation
 * suffix in the label when two managers expose the same preset name). We
 * don't store `api` on the scope — see the module docstring.
 *
 * @param {object} context - SillyTavern context.
 * @returns {Array<{name:string, api:string}>}
 */
export function listAllPresets(context) {
    // The set of APIs whose preset managers we walk. ST exposes one preset
    // manager per chat-completion-flavored backend; "openai" is the legacy
    // fallback that every install has, and the rest cover the actively-
    // supported backends in Luker today.
    const APIS = ['openai', 'claude', 'textgenerationwebui', 'kobold', 'novel'];
    const seen = new Map(); // name → api (first manager that claimed the name)
    const out = [];
    if (!context || typeof context.getPresetManager !== 'function') return out;
    for (const api of APIS) {
        let names;
        try {
            const mgr = context.getPresetManager(api);
            names = mgr && typeof mgr.getAllPresets === 'function' ? mgr.getAllPresets() : null;
        } catch (_) { names = null; }
        if (!Array.isArray(names)) continue;
        for (const raw of names) {
            const name = String(raw || '').trim();
            if (!name) continue;
            if (seen.has(name)) continue; // first manager wins — same preset name in two managers is rare and we surface the (api) suffix to distinguish in the label below
            seen.set(name, api);
            out.push({ name, api });
        }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

/**
 * Resolve the currently-active preset name. Used as the default selection
 * when the picker opens without a `suggestScope.name`.
 *
 * Falls through preset managers in the same order as listAllPresets so the
 * "first manager with a selected preset wins" behaviour matches what the
 * dropdown shows.
 *
 * @param {object} context
 * @returns {string}
 */
export function getActivePresetName(context) {
    const APIS = ['openai', 'claude', 'textgenerationwebui', 'kobold', 'novel'];
    if (!context || typeof context.getPresetManager !== 'function') return '';
    for (const api of APIS) {
        try {
            const mgr = context.getPresetManager(api);
            const sel = mgr && typeof mgr.getSelectedPresetName === 'function'
                ? String(mgr.getSelectedPresetName() || '').trim()
                : '';
            if (sel) return sel;
        } catch (_) { /* try next */ }
    }
    return '';
}

/**
 * Enumerate visible characters as `{value, label}` pairs. `value` is the
 * avatar file (matches `Scope.characterFile`); label is the display name
 * with the avatar appended in parentheses so duplicates are still
 * distinguishable.
 *
 * @param {object} context
 * @returns {Array<{value:string, label:string}>}
 */
export function listCharacters(context) {
    const list = Array.isArray(context?.characters) ? context.characters : [];
    const out = [];
    for (const c of list) {
        if (!c || typeof c !== 'object') continue;
        const avatar = typeof c.avatar === 'string' ? c.avatar : '';
        if (!avatar) continue;
        const name = typeof c.name === 'string' && c.name.trim() ? c.name : avatar;
        // Disambiguate same-name characters by appending the avatar when it
        // differs from the display name. Cheap and avoids confusion.
        const label = name === avatar ? name : `${name} (${avatar})`;
        out.push({ value: avatar, label });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
}

/**
 * Enumerate every orchestrator-preset scope currently defined across all
 * 4 orchestrator modes (spec / agenda / loop / director). Reads directly
 * from `context.extensionSettings.orchestrator.presetLibraries[mode]`,
 * which is populated by the orchestrator plugin at init time; null-safe
 * so the picker still works when orchestrator isn't loaded (empty array).
 *
 * Returned tuples are sorted by (mode, name) so the picker dropdown
 * shows a stable order.
 *
 * @param {object} context
 * @returns {Array<{mode:string, name:string}>}
 */
export function listAllOrchPresetScopes(context) {
    const libs = context?.extensionSettings?.orchestrator?.presetLibraries;
    if (!libs || typeof libs !== 'object') return [];
    const MODES = ['spec', 'agenda', 'loop', 'director'];
    const out = [];
    for (const mode of MODES) {
        const table = libs[mode];
        if (!table || typeof table !== 'object') continue;
        for (const id of Object.keys(table)) {
            const entry = table[id];
            const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
            if (!name) continue;
            out.push({ mode, name });
        }
    }
    out.sort((a, b) => a.mode.localeCompare(b.mode) || a.name.localeCompare(b.name));
    return out;
}

/**
 * Build the picker body HTML. Exported so the unit tests can assert
 * dropdown contents without instantiating the popup.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {(s:string) => string} opts.t
 * @param {string} opts.suggestKind - 'global'|'preset'|'orch-preset'|'character'
 * @param {string} opts.suggestPreset - default preset name
 * @param {string} opts.suggestChar - default character file
 * @param {{mode:string,name:string}|null} opts.suggestOrchPreset - default orch-preset tuple
 * @param {Array<{name:string, api:string}>} opts.presets
 * @param {Array<{value:string, label:string}>} opts.characters
 * @param {Array<{mode:string, name:string}>} opts.orchPresetScopes
 * @returns {string}
 */
export function buildScopePickerHtml({
    title,
    t,
    suggestKind,
    suggestPreset,
    suggestChar,
    suggestOrchPreset,
    presets,
    characters,
    orchPresetScopes,
} = {}) {
    const kindRadio = (value, label) => {
        const checked = suggestKind === value ? ' checked' : '';
        return `<label class="luker_skill_scope_kind_option">
            <input type="radio" name="luker_skill_scope_kind" value="${value}"${checked}>
            ${esc(t(label))}
        </label>`;
    };
    const presetOptions = presets.length > 0
        ? presets.map(p => {
            const sel = p.name === suggestPreset ? ' selected' : '';
            // The (api) suffix is only useful when two managers share a
            // preset name; otherwise it's noise. listAllPresets already
            // dedupes by first-manager-wins, so a duplicate is only visible
            // here if the user constructs custom data. Cheap to always show.
            const label = p.api ? `${p.name} (${p.api})` : p.name;
            return `<option value="${esc(p.name)}"${sel}>${esc(label)}</option>`;
        }).join('')
        : `<option value="" disabled selected>${esc(t('(no chat completion presets)'))}</option>`;
    const characterOptions = characters.length > 0
        ? characters.map(c => {
            const sel = c.value === suggestChar ? ' selected' : '';
            return `<option value="${esc(c.value)}"${sel}>${esc(c.label)}</option>`;
        }).join('')
        : `<option value="" disabled selected>${esc(t('(no characters loaded)'))}</option>`;
    const orchPresetList = Array.isArray(orchPresetScopes) ? orchPresetScopes : [];
    const suggestOrchValue = suggestOrchPreset
        ? `orch-preset/${suggestOrchPreset.mode}/${suggestOrchPreset.name}`
        : '';
    const orchPresetOptions = orchPresetList.length > 0
        ? orchPresetList.map(s => {
            const value = `orch-preset/${s.mode}/${s.name}`;
            const sel = value === suggestOrchValue ? ' selected' : '';
            return `<option value="${esc(value)}"${sel}>${esc(`${s.mode} / ${s.name}`)}</option>`;
        }).join('')
        : `<option value="" disabled selected>${esc(t('(no orchestrator presets)'))}</option>`;
    const presetHidden = suggestKind !== 'preset';
    const charHidden = suggestKind !== 'character';
    const orchPresetHidden = suggestKind !== 'orch-preset';
    return `
<div class="luker_skill_scope_picker">
    <div class="luker_skill_scope_picker_title">${esc(title)}</div>
    <div class="luker_skill_scope_picker_kinds">
        ${kindRadio('global', 'Global')}
        ${kindRadio('preset', 'Preset')}
        ${kindRadio('orch-preset', 'Orchestrator preset')}
        ${kindRadio('character', 'Character')}
    </div>
    <div class="luker_skill_scope_preset_fields" data-skill-scope-row="preset"${presetHidden ? ' hidden' : ''}>
        <label class="luker_skill_scope_field">
            <span class="luker_skill_scope_field_label">${esc(t('Chat completion preset'))}</span>
            <select class="text_pole" data-skill-scope-preset>${presetOptions}</select>
        </label>
    </div>
    <div class="luker_skill_scope_orch_preset_fields" data-skill-scope-row="orch-preset"${orchPresetHidden ? ' hidden' : ''}>
        <label class="luker_skill_scope_field">
            <span class="luker_skill_scope_field_label">${esc(t('Orchestrator preset'))}</span>
            <select class="text_pole" data-skill-scope-orch-preset>${orchPresetOptions}</select>
        </label>
    </div>
    <div class="luker_skill_scope_character_fields" data-skill-scope-row="character"${charHidden ? ' hidden' : ''}>
        <label class="luker_skill_scope_field">
            <span class="luker_skill_scope_field_label">${esc(t('Character'))}</span>
            <select class="text_pole" data-skill-scope-character>${characterOptions}</select>
        </label>
    </div>
</div>
    `;
}

/**
 * Open the scope picker popup and resolve to the chosen scope. Returns
 * `null` when the user cancels.
 *
 * @param {object} context - SillyTavern context (must expose Popup,
 *   POPUP_RESULT, POPUP_TYPE, getPresetManager, characters).
 * @param {(s:string) => string} t - i18n helper.
 * @param {string} title - dialog header text.
 * @param {object|null} suggestScope - pre-fill defaults.
 * @returns {Promise<object|null>}
 */
export async function pickTargetScope(context, t = (s) => s, title = '', suggestScope = null) {
    if (!context) return null;
    ensureSkillI18n();
    const Popup = context.Popup;
    const POPUP_RESULT = context.POPUP_RESULT;
    const POPUP_TYPE = context.POPUP_TYPE;
    if (!Popup || !POPUP_RESULT || !POPUP_TYPE) {
        if (typeof toastr !== 'undefined') {
            toastr.error(String(t('Popup API missing — cannot pick scope.')));
        }
        return null;
    }

    const presets = listAllPresets(context);
    const characters = listCharacters(context);
    const suggestKind = suggestScope?.kind || 'global';
    // Default preset: suggested → currently-active → first available.
    const suggestPreset = (suggestScope?.name && presets.some(p => p.name === suggestScope.name))
        ? suggestScope.name
        : (getActivePresetName(context) || presets[0]?.name || '');
    const suggestChar = (suggestScope?.characterFile && characters.some(c => c.value === suggestScope.characterFile))
        ? suggestScope.characterFile
        : (characters[0]?.value || '');
    const orchPresetScopes = listAllOrchPresetScopes(context);
    const suggestOrchPreset = (suggestScope?.kind === 'orch-preset'
            && suggestScope.mode
            && suggestScope.name
            && orchPresetScopes.some(s => s.mode === suggestScope.mode && s.name === suggestScope.name))
        ? { mode: suggestScope.mode, name: suggestScope.name }
        : (orchPresetScopes[0] || null);

    const html = buildScopePickerHtml({
        title,
        t,
        suggestKind,
        suggestPreset,
        suggestChar,
        suggestOrchPreset,
        presets,
        characters,
        orchPresetScopes,
    });

    let chosen = null;
    const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', {
        okButton: t('OK'),
        cancelButton: t('Cancel'),
        wider: true,
        onClosing: (p) => {
            if (p.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            const dlg = p.dlg;
            const kind = dlg.querySelector('input[name="luker_skill_scope_kind"]:checked')?.value || 'global';
            if (kind === 'global') {
                chosen = { kind: 'global' };
                return true;
            }
            if (kind === 'preset') {
                const presetName = String(dlg.querySelector('[data-skill-scope-preset]')?.value || '').trim();
                if (!presetName) {
                    if (typeof toastr !== 'undefined') {
                        toastr.error(String(t('Preset scope requires picking a preset.')));
                    }
                    return false;
                }
                chosen = { kind: 'preset', name: presetName };
                return true;
            }
            if (kind === 'orch-preset') {
                const raw = String(dlg.querySelector('[data-skill-scope-orch-preset]')?.value || '').trim();
                // Value shape is `orch-preset/<mode>/<name>` — matches the
                // canonical encoding in src/skills/scope.js so we can just
                // split on the first two '/' and reject anything malformed.
                const parts = raw.split('/');
                if (parts.length !== 3 || parts[0] !== 'orch-preset' || !parts[1] || !parts[2]) {
                    if (typeof toastr !== 'undefined') {
                        toastr.error(String(t('Orchestrator preset scope requires picking a preset.')));
                    }
                    return false;
                }
                chosen = { kind: 'orch-preset', mode: parts[1], name: parts[2] };
                return true;
            }
            if (kind === 'character') {
                const characterFile = String(dlg.querySelector('[data-skill-scope-character]')?.value || '').trim();
                if (!characterFile) {
                    if (typeof toastr !== 'undefined') {
                        toastr.error(String(t('Character scope requires picking a character.')));
                    }
                    return false;
                }
                chosen = { kind: 'character', characterFile };
                return true;
            }
            return true;
        },
    });

    const popupPromise = popup.show();

    // After the popup renders, wire kind-radio show/hide.
    const dlg = popup.dlg;
    if (dlg) {
        const presetRow = dlg.querySelector('[data-skill-scope-row="preset"]');
        const orchPresetRow = dlg.querySelector('[data-skill-scope-row="orch-preset"]');
        const charRow = dlg.querySelector('[data-skill-scope-row="character"]');
        const applyKindVisibility = (kind) => {
            if (presetRow) presetRow.hidden = kind !== 'preset';
            if (orchPresetRow) orchPresetRow.hidden = kind !== 'orch-preset';
            if (charRow) charRow.hidden = kind !== 'character';
        };
        dlg.querySelectorAll('input[name="luker_skill_scope_kind"]').forEach(radio => {
            radio.addEventListener('change', () => {
                if (radio.checked) applyKindVisibility(radio.value);
            });
        });
        applyKindVisibility(suggestKind);
    }

    const result = await popupPromise;
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    return chosen;
}
