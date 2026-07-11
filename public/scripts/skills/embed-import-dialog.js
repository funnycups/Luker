/**
 * Skill embed import dialog.
 *
 * Surfaces `extensions.luker.embedded_skills_source` payloads embedded in
 * character cards or presets as a per-skill conflict-resolution table:
 *   - `new`       → auto-install (always replace)
 *   - `same`      → auto-skip silently (server's `already_installed` path)
 *   - `different` → user picks Skip / Replace per row
 *
 * The dialog is shared by:
 *   - Card-app character import (after the card lands but before commit)
 *   - Preset-manager import (after the JSON parses but before save)
 *   - Card-bound preset materialize (skills from a character-bound preset
 *     are pinned to character scope)
 *
 * Flow:
 *   1. Detect `extensions.luker.embedded_skills_source` on the imported asset.
 *   2. Call `context.skills.previewExtractEmbed({payload, targetScope})` to
 *      classify each skill as new / same / different.
 *   3. Render a table with per-`different`-row Skip/Replace radios.
 *   4. On confirm, call `context.skills.executeExtractEmbed(...)` with the
 *      collected per-skill conflictStrategies map.
 *
 * Like the other Unit-{2..4} dialogs, pure helpers are exported for tests
 * without needing a DOM (Luker's Jest runs in node, not jsdom). The
 * interactive entry point `runEmbedImportFlow` is what callers (card-app /
 * preset-manager hooks) invoke.
 */

import { ensureSkillI18n } from './i18n.js';

// ── Pure helpers (exported for tests) ─────────────────────────────────────

/**
 * Format a SkillScope object as a short user-facing label.
 * Mirrors `formatScopeLabel` in skill-manager-panel.js — duplicated here
 * to keep this module standalone (avoids cross-module import bloat in the
 * card-app browser bundle).
 *
 * @param {object} scope
 * @returns {string}
 */
export function formatScopeLabel(scope, t = (s) => s) {
    if (!scope || typeof scope !== 'object') return t('unknown');
    switch (scope.kind) {
        case 'global': return t('global');
        case 'preset': return `${t('preset')}: ${scope.name}`;
        case 'orch-preset': return `${t('orchestrator preset')} (${scope.mode}): ${scope.name}`;
        case 'character': return `${t('character')}: ${scope.characterFile}`;
        default: return t('unknown');
    }
}

/**
 * Extract the embedded skills payload from a parsed character card or preset
 * object. Returns null if the payload is missing or malformed.
 *
 * Both characters and presets store the payload at the same path:
 * `obj.extensions.luker.embedded_skills_source`. For character cards loaded
 * via the v2/v3 spec, the path is `character.data.extensions.luker.embedded_skills_source`
 * (the inner `.data` wrapper is the card-spec envelope). Caller must pass the
 * object containing `.extensions` (i.e. for characters, pass `character.data`).
 *
 * @param {object} obj
 * @returns {object|null} the payload, or null when missing
 */
export function getEmbeddedSkillsSource(obj) {
    const payload = obj?.extensions?.luker?.embedded_skills_source;
    if (!payload || typeof payload !== 'object') return null;
    if (payload.version !== 1) return null;
    if (!Array.isArray(payload.items)) return null;
    return payload;
}

/**
 * Default per-skill conflict strategies given a preview response. Used as
 * the initial state for the dialog and as a no-UI fallback for tests:
 *   - new       → 'replace'   (server treats this as install)
 *   - same      → 'skip'      (server short-circuits already_installed)
 *   - different → 'skip'      (default-safe; user can toggle to replace)
 *   - invalid   → omitted     (server will surface the error)
 *
 * @param {Array<{name:string, conflict:string}>} previewItems
 * @returns {Object<string,'skip'|'replace'>}
 */
export function buildDefaultConflictStrategies(previewItems) {
    const out = {};
    for (const item of Array.isArray(previewItems) ? previewItems : []) {
        if (!item || !item.name) continue;
        if (item.conflict === 'new') out[item.name] = 'replace';
        else if (item.conflict === 'same') out[item.name] = 'skip';
        else if (item.conflict === 'different') out[item.name] = 'skip';
    }
    return out;
}

/**
 * Build the per-skill table HTML for the dialog. One row per preview item,
 * with a Skip/Replace radio pair for `different` rows and a status badge
 * (auto-install / already-installed / invalid) for the others.
 *
 * @param {Array} previewItems - output of context.skills.previewExtractEmbed
 * @param {(s:string)=>string} t - i18n helper
 * @param {(s:string)=>string} esc - html-escape helper
 * @returns {string}
 */
export function buildImportTableHtml(previewItems, t, esc) {
    const items = Array.isArray(previewItems) ? previewItems : [];
    if (items.length === 0) {
        return `<div class="luker_skill_import_empty">${esc(t('No skills found in the embed payload.'))}</div>`;
    }
    const renderRow = (item, idx) => {
        const safeName = esc(item.name || `(item-${idx})`);
        if (item.conflict === 'new') {
            return `
                <tr data-skill-import-row data-skill-import-name="${safeName}" data-skill-import-conflict="new">
                    <td class="luker_skill_import_name">${safeName}</td>
                    <td class="luker_skill_import_status luker_skill_import_status_new">${esc(t('New (install)'))}</td>
                    <td class="luker_skill_import_action"></td>
                </tr>
            `;
        }
        if (item.conflict === 'same') {
            return `
                <tr data-skill-import-row data-skill-import-name="${safeName}" data-skill-import-conflict="same">
                    <td class="luker_skill_import_name">${safeName}</td>
                    <td class="luker_skill_import_status luker_skill_import_status_same">${esc(t('Already installed (skip)'))}</td>
                    <td class="luker_skill_import_action"></td>
                </tr>
            `;
        }
        if (item.conflict === 'different') {
            // Use unique radio names per row so each row picks independently.
            const radioGroup = `luker_skill_import_decision_${idx}`;
            return `
                <tr data-skill-import-row data-skill-import-name="${safeName}" data-skill-import-conflict="different">
                    <td class="luker_skill_import_name">${safeName}</td>
                    <td class="luker_skill_import_status luker_skill_import_status_diff">${esc(t('Different (choose)'))}</td>
                    <td class="luker_skill_import_action">
                        <label><input type="radio" name="${radioGroup}" value="skip" checked data-skill-import-radio="${safeName}"> ${esc(t('Skip'))}</label>
                        <label><input type="radio" name="${radioGroup}" value="replace" data-skill-import-radio="${safeName}"> ${esc(t('Replace'))}</label>
                    </td>
                </tr>
            `;
        }
        // 'invalid' or unknown: surface but don't include in execute.
        return `
            <tr data-skill-import-row data-skill-import-name="${safeName}" data-skill-import-conflict="invalid">
                <td class="luker_skill_import_name">${safeName}</td>
                <td class="luker_skill_import_status luker_skill_import_status_invalid">${esc(t('Invalid (will be ignored)'))}</td>
                <td class="luker_skill_import_action"></td>
            </tr>
        `;
    };
    return `
<table class="luker_skill_import_table">
    <thead>
        <tr>
            <th>${esc(t('Skill'))}</th>
            <th>${esc(t('Status'))}</th>
            <th>${esc(t('Action'))}</th>
        </tr>
    </thead>
    <tbody>
        ${items.map(renderRow).join('')}
    </tbody>
</table>
    `;
}

/**
 * Build the full dialog body HTML (header + scope label + table).
 *
 * @param {object} targetScope
 * @param {Array} previewItems
 * @param {(s:string)=>string} t
 * @param {(s:string)=>string} esc
 * @returns {string}
 */
export function buildDialogHtml(targetScope, previewItems, t, esc) {
    return `
<div class="luker_skill_import_dialog">
    <div class="luker_skill_import_header">
        <div>${esc(t('Skills embedded in this asset will be installed into:'))}</div>
        <div class="luker_skill_import_target_label"><b>${esc(formatScopeLabel(targetScope, t))}</b></div>
    </div>
    ${buildImportTableHtml(previewItems, t, esc)}
</div>
    `;
}

/**
 * Read the user's per-skill decisions from the rendered table back into a
 * conflictStrategies map suitable for `executeExtractEmbed`. Only includes
 * `different` rows (others are pinned by buildDefaultConflictStrategies);
 * the strategy for `new`/`same` is forced to ensure round-trip parity
 * regardless of any radios the caller may have added.
 *
 * @param {Element|null} root - the dialog root containing the table
 * @param {Array} previewItems
 * @returns {Object<string,'skip'|'replace'>}
 */
export function collectConflictStrategies(root, previewItems) {
    const defaults = buildDefaultConflictStrategies(previewItems);
    if (!root || typeof root.querySelectorAll !== 'function') return defaults;
    const out = { ...defaults };
    const radios = root.querySelectorAll('input[type="radio"][data-skill-import-radio]');
    // Walk the keyed radios; later .checked entries override earlier ones
    // (the browser only allows one per group, but defensively pick the last
    // truthy match in case of stub-DOM quirks).
    for (const r of radios) {
        if (!r.checked) continue;
        const name = r.getAttribute('data-skill-import-radio');
        const value = String(r.value || '').toLowerCase();
        if (!name) continue;
        if (value === 'replace' || value === 'skip') {
            out[name] = value;
        }
    }
    return out;
}

// ── Interactive popup entry point ─────────────────────────────────────────

/**
 * Run the full embed-import flow: preview → user dialog → execute. Returns
 * the server's execute result on success (or a partial result with an
 * `aborted: true` flag if the user cancelled).
 *
 * @param {object} opts
 * @param {object} opts.context - SillyTavern context (needs `skills`,
 *   `callGenericPopup`, `POPUP_TYPE`, `POPUP_RESULT`).
 * @param {object} opts.payload - the parsed `embedded_skills_source` payload
 * @param {object} opts.targetScope - the scope to install into
 * @param {(s:string)=>string} [opts.t] - i18n helper; default identity
 * @returns {Promise<{installed?:Array, skipped?:Array, aborted?:boolean, error?:string}>}
 */
export async function runEmbedImportFlow({ context, payload, targetScope, t = (s) => s } = {}) {
    ensureSkillI18n();
    if (!context || !context.skills) {
        throw new Error('runEmbedImportFlow: context.skills missing');
    }
    if (!payload || typeof payload !== 'object') {
        throw new Error('runEmbedImportFlow: payload missing');
    }
    if (!targetScope || typeof targetScope !== 'object') {
        throw new Error('runEmbedImportFlow: targetScope missing');
    }

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
    })[c]);

    // 1) Preview
    let preview;
    try {
        preview = await context.skills.previewExtractEmbed({ payload, targetScope });
    } catch (e) {
        toast(t('Skill embed preview failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        return { aborted: true, error: e?.message || String(e) };
    }

    const items = Array.isArray(preview?.items) ? preview.items : [];
    if (items.length === 0) {
        // Nothing to do — no skills to install. Caller can ignore.
        return { installed: [], skipped: [], aborted: false };
    }

    // 2) Show dialog with per-skill decisions (driven by `different` rows).
    //
    // The dialog uses Luker's `Popup` class for fine-grained access to the
    // rendered DOM (so we can read radio state on close). callGenericPopup
    // returns just the result code; Popup gives us `popup.dlg` for DOM scrapes.
    const Popup = context.Popup;
    const POPUP_TYPE = context.POPUP_TYPE;
    const POPUP_RESULT = context.POPUP_RESULT;
    if (!Popup || !POPUP_TYPE || !POPUP_RESULT) {
        toast(t('Popup API missing — cannot show import dialog.'), 'error');
        return { aborted: true, error: 'popup-api-missing' };
    }

    const html = buildDialogHtml(targetScope, items, t, esc);
    let collectedStrategies = null;
    const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', {
        okButton: t('Install'),
        cancelButton: t('Cancel'),
        wider: true,
        allowVerticalScrolling: true,
        onClosing: (p) => {
            // Only collect on the AFFIRMATIVE path; cancel returns null.
            if (p.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            collectedStrategies = collectConflictStrategies(p.dlg, items);
            return true;
        },
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return { aborted: true };
    }

    // 3) Execute the materialization with the collected strategies.
    const conflictStrategies = collectedStrategies || buildDefaultConflictStrategies(items);
    try {
        const out = await context.skills.executeExtractEmbed({
            payload,
            targetScope,
            conflictStrategies,
        });
        const installed = Array.isArray(out?.installed) ? out.installed.length : 0;
        const skipped = Array.isArray(out?.skipped) ? out.skipped.length : 0;
        toast(t('Skills imported: ${0} installed, ${1} skipped.')
            .replace('${0}', String(installed))
            .replace('${1}', String(skipped)), 'success');
        return out || { installed: [], skipped: [] };
    } catch (e) {
        toast(t('Skill import failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        return { aborted: true, error: e?.message || String(e) };
    }
}

function toast(message, level) {
    if (typeof toastr === 'undefined') {
        // eslint-disable-next-line no-console
        console.warn('[embed-import-dialog]', message);
        return;
    }
    if (level === 'error') toastr.error(String(message));
    else if (level === 'success') toastr.success(String(message));
    else toastr.info(String(message));
}
