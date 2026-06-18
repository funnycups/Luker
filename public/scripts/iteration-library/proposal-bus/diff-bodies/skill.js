// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Shared body renderer for skill-author ProposalBus cards. Pulled out of
 * orch / cpa iter-studio so the same per-file LCS card chrome renders
 * regardless of which popup staged the proposal. Mirrors the pre-bus
 * helpers from orch's `renderSkillDiffBody` / `renderSkillStructuralBody`
 * (commit 3de0c3ecc) — the LCS body itself is delegated to the iter-lib's
 * shared `ITER_UI.diff.renderDiffCard` so visual conventions stay
 * consistent across popups.
 *
 * Entry shape (set by the popup at propose time):
 *   entry.op        — { name: 'skill_*', args: { name, scope, path, ... } }
 *   entry.meta      — { skillName, scope, path, before, after, extras? }
 *     before/after  — for content / frontmatter / create: strings
 *                     for rename: { name }
 *                     for change_scope: { scope }
 *                     for delete: { exists: boolean }
 */

import * as ITER_UI from '../../ui/index.js';

const SKILL_KIND_META = Object.freeze({
    content: { icon: '✏️', label: (t) => t('Update skill file') },
    frontmatter: { icon: '🏷️', label: (t) => t('Update skill frontmatter') },
    create: { icon: '✨', label: (t) => t('Create skill') },
    rename: { icon: '🔤', label: (t) => t('Rename skill') },
    change_scope: { icon: '📦', label: (t) => t('Move skill scope') },
    delete: { icon: '🗑️', label: (t) => t('Delete skill') },
});

function deriveKind(op) {
    switch (op?.name) {
        case 'skill_create':              return 'create';
        case 'skill_update_content':      return 'content';
        case 'skill_edit_content':        return 'content';
        case 'skill_update_frontmatter':  return 'frontmatter';
        case 'skill_rename':              return 'rename';
        case 'skill_change_scope':        return 'change_scope';
        case 'skill_delete':              return 'delete';
        default:                          return '';
    }
}

function escapeHtmlLocal(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
    }[c]));
}

export function scopeDisplay(scope, t, tf) {
    if (!scope || typeof scope !== 'object') return t('(unknown scope)');
    if (scope.kind === 'global') return t('global');
    if (scope.kind === 'preset' && scope.name) return tf('preset:${0}', String(scope.name));
    if (scope.kind === 'character' && scope.characterFile) return tf('character:${0}', String(scope.characterFile));
    return String(scope.kind || '?');
}

function renderStructuralBody(kind, meta, t, tf) {
    if (kind === 'rename') {
        return `<div class="orch_it_skl_meta_row">
            <span class="orch_it_skl_meta_label">${escapeHtmlLocal(t('Name'))}:</span>
            <span class="orch_it_skl_meta_was">${escapeHtmlLocal(String(meta?.before?.name || meta?.skillName || ''))}</span>
            <span class="orch_it_skl_meta_arrow">→</span>
            <span class="orch_it_skl_meta_now">${escapeHtmlLocal(String(meta?.after?.name || ''))}</span>
        </div>`;
    }
    if (kind === 'change_scope') {
        return `<div class="orch_it_skl_meta_row">
            <span class="orch_it_skl_meta_label">${escapeHtmlLocal(t('Scope'))}:</span>
            <span class="orch_it_skl_meta_was">${escapeHtmlLocal(scopeDisplay(meta?.before?.scope, t, tf))}</span>
            <span class="orch_it_skl_meta_arrow">→</span>
            <span class="orch_it_skl_meta_now">${escapeHtmlLocal(scopeDisplay(meta?.after?.scope, t, tf))}</span>
        </div>`;
    }
    if (kind === 'delete') {
        return `<div class="orch_it_skl_meta_row orch_it_skl_meta_destructive">
            ${escapeHtmlLocal(tf('Skill "${0}" (${1}) will be deleted on Apply. All files removed; this cannot be undone.',
        String(meta?.skillName || ''), scopeDisplay(meta?.scope, t, tf)))}
        </div>`;
    }
    return '';
}

function renderContentBody(meta, path, t, tf) {
    // For content / frontmatter / create, hand the before/after strings
    // to the shared diff card so the popup renders the same line-by-line
    // LCS the lorebook + orch profile cards use.
    const diffEdit = {
        op: 'set',
        path: String(path || 'SKILL.md'),
        oldValue: typeof meta?.before === 'string' ? meta.before : '',
        newValue: typeof meta?.after === 'string' ? meta.after : '',
    };
    const html = ITER_UI.diff.renderDiffCard([diffEdit], { i18n: tf });
    if (!html) {
        return `<div class="orch_it_skl_nochange">${escapeHtmlLocal(t('No content change'))}</div>`;
    }
    return html;
}

function renderExtras(meta, t, tf) {
    const extras = meta?.extras?.extraFiles;
    if (!Array.isArray(extras) || extras.length === 0) return '';
    return `<div class="orch_it_skl_extras">${escapeHtmlLocal(tf('Plus ${0} additional file(s): ${1}',
        String(extras.length), extras.join(', ')))}</div>`;
}

/**
 * @param {Object} entry  ProposalBus entry as stored on the bus
 * @param {Object} helpers  { i18n: (s, ...args) => string }
 * @returns {string} HTML for the card body
 */
export function renderSkillBody(entry, helpers) {
    const i18n = typeof helpers?.i18n === 'function' ? helpers.i18n : (s) => String(s ?? '');
    const t = i18n;
    const tf = i18n;
    const op = entry?.op || {};
    const meta = entry?.meta || {};
    const kind = deriveKind(op);
    if (kind === 'rename' || kind === 'change_scope' || kind === 'delete') {
        return renderStructuralBody(kind, meta, t, tf);
    }
    if (kind === 'create') {
        // skill_create: meta.before is null (no prior file); render an
        // empty → full-text LCS so the user sees the new file verbatim.
        // Synthesize a string for the diff input.
        const stagedMeta = { ...meta, before: typeof meta?.before === 'string' ? meta.before : '' };
        return renderContentBody(stagedMeta, meta?.path || 'SKILL.md', t, tf) + renderExtras(meta, t, tf);
    }
    if (kind === 'content' || kind === 'frontmatter') {
        return renderContentBody(meta, meta?.path || (kind === 'frontmatter' ? 'SKILL.md' : ''), t, tf);
    }
    return '';
}

export function skillLabel(entry, helpers) {
    const i18n = typeof helpers?.i18n === 'function' ? helpers.i18n : (s) => String(s ?? '');
    const t = i18n;
    const kind = deriveKind(entry?.op);
    const m = SKILL_KIND_META[kind];
    return m ? m.label(t) : (entry?.op?.name || t('Skill change'));
}

export function skillIcon(entry) {
    const kind = deriveKind(entry?.op);
    return SKILL_KIND_META[kind]?.icon || '🧩';
}

export function skillTarget(entry, helpers) {
    const i18n = typeof helpers?.i18n === 'function' ? helpers.i18n : (s) => String(s ?? '');
    const t = i18n;
    const tf = i18n;
    const meta = entry?.meta || {};
    const skillName = meta.skillName || entry?.op?.args?.name || '';
    const scope = meta.scope || entry?.op?.args?.scope;
    const path = meta.path || '';
    const scopeLabel = scope ? ` (${scopeDisplay(scope, t, tf)})` : '';
    return `${skillName}${scopeLabel}${path ? ` · ${path}` : ''}`;
}
