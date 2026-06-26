// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Shared body renderer for custom-tool-author ProposalBus cards. Renders
 * the four kinds of custom-tool proposals — upsert / patch_body /
 * patch_schema / remove — with a safety banner (the function body runs
 * with full session permissions), the tool's mode chip, the description,
 * and a per-section diff or full-body view.
 *
 * Entry shape (set by studio.js at propose time, mirrors
 * skill-author's meta shape):
 *   entry.op    — { name: 'luker_orch_set_custom_tool' | ..., args: {...} }
 *   entry.meta  — { kind, name, before, after }
 *                 before/after are full tool entries
 *                 (name/description/mode/parameters/body/simulateBody) or
 *                 null when creating / deleting.
 */

import * as ITER_UI from '../../ui/index.js';

const KIND_META = Object.freeze({
    upsert: { icon: '🧩', label: (t) => t('Author custom tool') },
    patch_body: { icon: '✏️', label: (t) => t('Patch custom tool body') },
    patch_schema: { icon: '🧬', label: (t) => t('Patch custom tool parameters') },
    remove: { icon: '🗑️', label: (t) => t('Remove custom tool') },
});

function escapeHtmlLocal(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
    }[c]));
}

function renderField(label, value) {
    if (value == null || value === '') return '';
    return `<div class="orch_it_ct_meta_row">
        <span class="orch_it_ct_meta_label">${escapeHtmlLocal(label)}:</span>
        <span class="orch_it_ct_meta_value">${escapeHtmlLocal(String(value))}</span>
    </div>`;
}

function renderSafetyBanner(t, after) {
    const mode = after?.mode === 'read' ? 'read' : 'write';
    const mark = mode === 'read'
        ? t('Read-mode tool: declared no side effects. The body still runs in your browser with full session permissions — review before approving.')
        : t('WRITE-mode tool: can mutate chat / character / world-info / settings. The body runs in your browser with full session permissions. Review carefully before approving.');
    return `<div class="orch_it_ct_warning">${escapeHtmlLocal(mark)}</div>`;
}

function renderDiffEdit(label, before, after, i18n) {
    const edit = {
        op: 'set',
        path: label,
        oldValue: typeof before === 'string' ? before : (before != null ? JSON.stringify(before, null, 2) : ''),
        newValue: typeof after === 'string' ? after : (after != null ? JSON.stringify(after, null, 2) : ''),
    };
    return ITER_UI.diff.renderDiffCard([edit], { i18n });
}

function renderFullBody(label, body) {
    if (!body) return '';
    return `<details class="orch_it_ct_body_details" open>
        <summary>${escapeHtmlLocal(label)}</summary>
        <pre class="monospace orch_it_ct_body_pre">${escapeHtmlLocal(body)}</pre>
    </details>`;
}

/**
 * @param {Object} entry ProposalBus entry
 * @param {Object} helpers { i18n: (s, ...args) => string }
 * @returns {string} HTML for the card body
 */
export function renderCustomToolBody(entry, helpers) {
    const i18n = typeof helpers?.i18n === 'function' ? helpers.i18n : (s) => String(s ?? '');
    const t = i18n;
    const op = entry?.op || {};
    const meta = entry?.meta || {};
    const kind = String(meta.kind || '');
    const before = meta.before || null;
    const after = meta.after || null;

    if (kind === 'remove') {
        const tool = before || {};
        const banner = `<div class="orch_it_ct_warning orch_it_ct_destructive">${escapeHtmlLocal(t(`This will delete "${tool.name || meta.name}" from the profile on Apply.`))}</div>`;
        const meta_rows = [
            renderField(t('Tool'), tool.name),
            renderField(t('Mode'), tool.mode),
            renderField(t('Description'), tool.description),
        ].join('');
        const body = renderFullBody(t('Body that will be removed:'), tool.body || '');
        return `${banner}${meta_rows}${body}`;
    }

    if (kind === 'upsert') {
        const banner = renderSafetyBanner(t, after);
        const isOverwrite = !!before;
        const headRows = [
            renderField(t('Tool'), after?.name),
            renderField(t('Mode'), after?.mode),
            renderField(t('Description'), after?.description),
        ].join('');
        const bodyView = isOverwrite
            ? renderDiffEdit(t('Body diff'), String(before?.body || ''), String(after?.body || ''), i18n)
            : renderFullBody(t('Body (new):'), String(after?.body || ''));
        const schemaView = isOverwrite && JSON.stringify(before?.parameters) !== JSON.stringify(after?.parameters)
            ? renderDiffEdit(t('Parameters diff'), before?.parameters, after?.parameters, i18n)
            : (!isOverwrite ? renderDiffEdit(t('Parameters (new):'), null, after?.parameters, i18n) : '');
        const simBlock = after?.simulateBody
            ? renderFullBody(t('Simulate body:'), String(after.simulateBody))
            : '';
        return `${banner}${headRows}${bodyView}${schemaView}${simBlock}`;
    }

    if (kind === 'patch_body') {
        const banner = renderSafetyBanner(t, after);
        const target = (op?.args?.target === 'simulateBody') ? 'simulateBody' : 'body';
        const headRows = [
            renderField(t('Tool'), after?.name),
            renderField(t('Mode'), after?.mode),
            renderField(t('Patching'), target),
        ].join('');
        return `${banner}${headRows}${renderDiffEdit(target === 'simulateBody' ? t('Simulate body diff') : t('Body diff'), String(before?.[target] || ''), String(after?.[target] || ''), i18n)}`;
    }

    if (kind === 'patch_schema') {
        const headRows = [
            renderField(t('Tool'), after?.name),
            renderField(t('Mode'), after?.mode),
        ].join('');
        return `${headRows}${renderDiffEdit(t('Parameters diff'), before?.parameters, after?.parameters, i18n)}`;
    }

    return `<div class="orch_it_ct_unknown">${escapeHtmlLocal(t('Unknown custom-tool proposal kind: ${0}').replace('${0}', kind))}</div>`;
}

export function customToolLabel(entry, helpers) {
    const i18n = typeof helpers?.i18n === 'function' ? helpers.i18n : (s) => String(s ?? '');
    const m = KIND_META[String(entry?.meta?.kind || '')];
    return m ? m.label(i18n) : (entry?.op?.name || i18n('Custom-tool change'));
}

export function customToolIcon(entry) {
    return KIND_META[String(entry?.meta?.kind || '')]?.icon || '🧩';
}

export function customToolTarget(entry) {
    const meta = entry?.meta || {};
    return String(meta?.name || meta?.after?.name || meta?.before?.name || 'custom-tool');
}
