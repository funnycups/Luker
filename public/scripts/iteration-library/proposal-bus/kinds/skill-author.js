// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * skill-author KindHandler — wraps the iter-lib helper
 * `commitApprovedSkillProposal(op)` so any popup can stage skill-authoring
 * writes (create/update_content/edit_content/update_frontmatter/rename/
 * change_scope/delete) as ProposalBus entries.
 *
 * Op shape: { name: <skill_tool_name>, args: { scope, name, ... } }
 *
 * Snapshot is a `{ content: string }` object for file-mutating ops, or
 * `null` for ops whose "before" is not a single-file value (create, rename,
 * change_scope, delete). Fingerprint = sha256(canonicalJson(snapshot)).
 *
 * Inverse:
 *   - update_content / edit_content / update_frontmatter when snapshot is
 *     present -> a single `skill_update_content` op restoring the prior
 *     file body (matches the existing CPA/orch rollback path).
 *   - everything else -> null (no clean inverse).
 */

import { sha256OfJson } from '../drift-hash.js';

const FILE_OPS = new Set(['skill_update_content', 'skill_edit_content', 'skill_update_frontmatter']);

const DEFAULT_LABEL = 'Skill change';
const DEFAULT_ICON = '🧩';

function targetPath(op) {
    if (!op || typeof op !== 'object') return null;
    if (op.name === 'skill_update_frontmatter') return 'SKILL.md';
    const args = op.args && typeof op.args === 'object' ? op.args : {};
    if (typeof args.path === 'string' && args.path) return args.path;
    return null;
}

function isNotFoundError(err) {
    return /404|not found/i.test(String(err?.message || err || ''));
}

function defaultRenderDiff(_before, _op, helpers) {
    const t = helpers && typeof helpers.i18n === 'function' ? helpers.i18n : (s) => String(s ?? '');
    return `<div class="iter_proposal_diff_placeholder">${t('Skill change — no diff renderer registered')}</div>`;
}

export function createSkillAuthorHandler(opts = {}) {
    if (!opts || typeof opts.commitOp !== 'function') {
        throw new Error('createSkillAuthorHandler: commitOp is required');
    }
    if (typeof opts.readFile !== 'function') {
        throw new Error('createSkillAuthorHandler: readFile is required');
    }
    const commitOp = opts.commitOp;
    const readFile = opts.readFile;
    const renderDiff = typeof opts.renderDiff === 'function' ? opts.renderDiff : defaultRenderDiff;
    const labelFn = typeof opts.label === 'function' ? opts.label : null;
    const iconFn = typeof opts.icon === 'function' ? opts.icon : null;
    const targetFn = typeof opts.target === 'function' ? opts.target : null;

    async function fingerprint(snapshot) {
        return sha256OfJson(snapshot ?? null);
    }

    async function readCurrent(op) {
        if (!op || !FILE_OPS.has(op.name)) {
            return { snapshot: null, fingerprint: await fingerprint(null) };
        }
        const args = op.args && typeof op.args === 'object' ? op.args : {};
        const path = targetPath(op);
        if (!path) {
            return { snapshot: null, fingerprint: await fingerprint(null) };
        }
        let content = null;
        try {
            const raw = await readFile({ scope: args.scope, name: args.name, path });
            if (typeof raw === 'string') content = raw;
            else if (raw && typeof raw.content === 'string') content = raw.content;
        } catch (err) {
            if (!isNotFoundError(err)) throw err;
            content = null;
        }
        const snapshot = content === null ? null : { content };
        return { snapshot, fingerprint: await fingerprint(snapshot) };
    }

    async function commit(op) {
        return commitOp(op);
    }

    function inverse(op, snapshot) {
        if (!op || !FILE_OPS.has(op.name)) return null;
        if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.content !== 'string') {
            return null;
        }
        const args = op.args && typeof op.args === 'object' ? op.args : {};
        const path = targetPath(op);
        if (!path) return null;
        return {
            name: 'skill_update_content',
            args: {
                scope: args.scope,
                name: args.name,
                path,
                content: snapshot.content,
            },
        };
    }

    function renderDiffCard(entry, helpers) {
        return renderDiff(entry?.snapshot, entry?.op, helpers || {});
    }

    function label(entry) {
        if (labelFn) return labelFn(entry);
        const name = entry?.op?.name || '';
        return name ? `Skill: ${name}` : DEFAULT_LABEL;
    }
    function icon(entry) {
        return iconFn ? iconFn(entry) : DEFAULT_ICON;
    }
    function target(entry) {
        if (targetFn) return targetFn(entry);
        const args = entry?.op?.args || {};
        const skillName = args.name ?? '';
        const path = targetPath(entry?.op);
        if (!skillName && !path) return '';
        if (!path) return String(skillName);
        return `${skillName}/${path}`;
    }

    return {
        fingerprint,
        readCurrent,
        commit,
        inverse,
        renderDiffCard,
        label,
        icon,
        target,
        inverseAvailable: true,
    };
}
