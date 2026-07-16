/**
 * Skill embed export hook.
 *
 * Wires the export-side of the embed flow into Luker's existing preset
 * export event (OAI_PRESET_EXPORT_READY). The event fires from openai.js
 * with the preset body just before download; listeners can mutate the body
 * in place to attach extra fields (Luker's regex extension uses this same
 * pattern).
 *
 * UX: if the active preset has any preset-scope skills, surface a yes/no
 * confirm popup asking whether to include them. On yes, attach
 * `extensions.luker.embedded_skills_source`. If no skills exist for the
 * scope, this hook is a no-op (no spurious dialog).
 *
 * Character export goes through Luker's image-card serialization, which
 * doesn't currently emit a similar event. Until a CHARACTER_EXPORT_READY
 * hook lands, character-scope skills export piggybacks on the manual
 * "Pack to embed" path in the skill manager subpanel.
 */

import { attachEmbeddedSkillsSource, packAndAttachSkillsForExport } from './embed-export-helper.js';

/**
 * Confirm-then-attach for preset export. Resolves to true if the user opted
 * in and the payload was attached, false otherwise. Errors are swallowed
 * (logged) so the download still proceeds with the original preset body.
 *
 * @param {object} opts
 * @param {object} opts.context - SillyTavern context
 * @param {object} opts.data - the preset JSON being exported (mutated in
 *   place when the user opts in). Renamed from `presetBody` to align with
 *   the `{data, presetName}` payload shape carried by
 *   OAI_PRESET_EXPORT_READY (mirrors OAI_PRESET_IMPORT_READY, openai.js:6910).
 * @param {string} opts.presetName - the real name of the preset being
 *   exported (card slot name in card-bound mode, global name otherwise).
 *   Provided by the event so the hook no longer needs to reach into
 *   `oai_settings.preset_settings_openai`, which is stale global while
 *   a card-bound ghost is selected (the root of the export identity drift).
 * @param {(s:string)=>string} [opts.t]
 * @returns {Promise<boolean>}
 */
export async function maybeAttachSkillsToPresetExport({ context, data, presetName, t = (s) => s } = {}) {
    if (!context || !context.skills) return false;
    if (!data || typeof data !== 'object') return false;
    const trimmedName = String(presetName || '').trim();
    if (!trimmedName) return false;

    const targetScope = { kind: 'preset', name: trimmedName };

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
            attachTo: data,
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

/**
 * Confirm-then-attach for orchestrator preset export. Bundles every skill
 * "active" for the preset — i.e. every skill any agent in the profile can
 * see once loaded — regardless of source scope (global / oai-preset /
 * orch-preset). Character-scope skills are intentionally excluded; they
 * belong to the character card and travel with it separately.
 *
 * The importer materializes all bundled skills into the destination
 * `orch-preset/<mode>/<name>` scope, so this flow doubles as a scope
 * migration: cross-scope references collapse into the preset scope on
 * import, which is what "export active skills as preset-scope" means to
 * the user.
 *
 * (mode, name) are read from `payload.mode` and `payload.name` — see
 * `buildPortablePayloadForMode` in the orchestrator main.js. Envelope-
 * level `.name` is stamped for all 4 modes; `payload.profile?.name` is
 * a defensive fallback for external tooling that only populates the
 * profile field.
 *
 * @param {object} opts
 * @param {object} opts.context - SillyTavern context
 * @param {object} opts.payload - the outgoing preset JSON payload
 *   (mutated in place when the user opts in)
 * @param {(s:string)=>string} [opts.t]
 * @returns {Promise<boolean>}
 */
export async function maybeAttachSkillsToOrchPresetExport({ context, payload, t = (s) => s } = {}) {
    if (!context || !context.skills) return false;
    if (!payload || typeof payload !== 'object') return false;

    const mode = String(payload.mode || '').trim();
    const name = String(payload.name || payload.profile?.name || '').trim();
    if (!mode || !name) return false;
    const targetScope = { kind: 'orch-preset', mode, name };

    // Resolve every skill active for this preset across all source scopes.
    // Delegates profile-walking + resolver invocation to the orchestrator
    // plugin (via the extension-api boundary — core never imports from a
    // plugin). Returns Map<scopeKey, {scope, names[]}>. Empty = no active
    // skills / orchestrator plugin unavailable.
    let byScope;
    try {
        const orchApi = context.getExtensionApi
            ? context.getExtensionApi('orchestrator')
            : null;
        if (!orchApi || typeof orchApi.collectResolvedSkillsForOrchPreset !== 'function') {
            // Orchestrator plugin not loaded — fall back to the prior
            // scope-local behavior so the export still bundles any skill
            // that happens to live in orch-preset scope. This keeps the
            // hook viable in dev/test contexts where the plugin isn't
            // wired.
            const legacyList = await context.skills.list({ scope: targetScope });
            if (!Array.isArray(legacyList) || legacyList.length === 0) return false;
            const ok = await confirmIncludeOrchPresetSkills({
                context, t, list: legacyList, targetScope,
            });
            if (!ok) return false;
            const attached = await packAndAttachSkillsForExport({
                context, targetScope, attachTo: payload,
            });
            if (attached) {
                toast(
                    t('Bundled ${0} skill(s) with this preset.').replace('${0}', String(legacyList.length)),
                    'success',
                );
                return true;
            }
            return false;
        }
        byScope = await orchApi.collectResolvedSkillsForOrchPreset(payload);
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[embed-export-hook] resolve active skills failed:', e?.message || e);
        return false;
    }
    if (!byScope || byScope.size === 0) return false;

    // Flatten for the confirm popup (dedup by name across scopes for
    // display, but keep the per-scope grouping for the actual pack).
    const flatNames = new Set();
    for (const { names } of byScope.values()) {
        for (const n of names) flatNames.add(n);
    }
    if (flatNames.size === 0) return false;

    const displayList = [...flatNames].sort().map(n => ({ name: n }));
    const ok = await confirmIncludeOrchPresetSkills({ context, t, list: displayList, targetScope });
    if (!ok) return false;

    // Pack each source-scope group separately (server needs the source
    // scope to read the skill files), then merge the resulting items[]
    // into a single embed payload. Since embed items carry only the skill
    // name (not their source scope), the importer will materialize them
    // all into the destination orch-preset scope — this is exactly the
    // "export active skills as preset-scope" behavior users expect.
    //
    // Cross-scope collisions (same skill name in more than one source
    // scope) resolve in resolver-precedence order:
    //   character > orch-preset > oai-preset > global
    // character is excluded from packing, so precedence here is
    //   orch-preset > preset > global
    // (specialized > generic — matches runtime scope-merge semantics).
    try {
        const precedence = { global: 0, preset: 1, 'orch-preset': 2 };
        // name -> {kindRank, item}
        const dedup = new Map();
        for (const { scope, names } of byScope.values()) {
            if (!Array.isArray(names) || names.length === 0) continue;
            const kindRank = precedence[scope.kind];
            if (kindRank === undefined) continue;
            let sub;
            try {
                sub = await context.skills.packForEmbed({ scope, names, mode: 'auto' });
            } catch (e) {
                // Missing / concurrently-deleted skills in a single scope
                // shouldn't block the whole export — log and continue so
                // the remaining scopes still travel.
                // eslint-disable-next-line no-console
                console.warn('[embed-export-hook] pack scope failed:',
                    `${scope.kind}/${scope.name || scope.mode || ''}`,
                    e?.message || e);
                continue;
            }
            if (!sub || !Array.isArray(sub.items)) continue;
            for (const item of sub.items) {
                if (!item || typeof item !== 'object' || !item.name) continue;
                const prev = dedup.get(item.name);
                if (!prev || prev.kindRank < kindRank) {
                    dedup.set(item.name, { kindRank, item });
                }
            }
        }
        if (dedup.size === 0) {
            toast(t('No skills could be bundled with this preset.'), 'error');
            return false;
        }
        const finalItems = [...dedup.values()].map(v => v.item);
        const embedPayload = { version: 1, items: finalItems };
        attachEmbeddedSkillsSource(payload, embedPayload);
        toast(
            t('Bundled ${0} skill(s) with this preset.').replace('${0}', String(finalItems.length)),
            'success',
        );
        return true;
    } catch (e) {
        toast(t('Failed to bundle skills with preset: ${0}').replace('${0}', e?.message || String(e)), 'error');
    }
    return false;
}

// NOTE: `confirmIncludeOrchPresetSkills` is a near-duplicate of
// `confirmIncludeSkills` below — they differ only in the scope_label
// prefix and header text. Kept as a near-clone to keep the diff
// surgical; a future DRY pass can extract a shared
// `confirmIncludeSkillsForScope({header, scopeLabelPrefix, ...})` helper.
async function confirmIncludeOrchPresetSkills({ context, t, list, targetScope }) {
    if (!context.callGenericPopup || !context.POPUP_TYPE) return false;
    const names = list.map(s => s?.name).filter(Boolean);
    const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
    })[c]);
    const list_html = names.map(n => `<li>${escHtml(n)}</li>`).join('');
    const scope_label = `orchestrator preset (${escHtml(targetScope.mode)}): ${escHtml(targetScope.name)}`;
    const html = `
<div class="luker_skill_export_confirm">
    <div>${escHtml(t('Include all skills active for this orchestrator preset in the export?'))}</div>
    <div class="luker_skill_export_confirm_hint">${escHtml(t('Bundled skills will install into this preset\u2019s scope on import.'))}</div>
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

async function confirmIncludeSkills({ context, t, list, targetScope }) {
    if (!context.callGenericPopup || !context.POPUP_TYPE) return false;
    const names = list.map(s => s?.name).filter(Boolean);
    const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
    })[c]);
    const list_html = names.map(n => `<li>${escHtml(n)}</li>`).join('');
    const scope_label = `preset: ${escHtml(targetScope.name)}`;
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
