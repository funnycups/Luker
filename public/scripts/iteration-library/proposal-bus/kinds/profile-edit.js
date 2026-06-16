// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * profile-edit KindHandler — generic "live state replace" used by all four
 * iter-studio popups for their internal working profile. Each popup
 * injects its own commitLive (the existing applyPendingEdits-then-flush
 * path) and readLive (the live-state getter) so the bus stays oblivious
 * to popup-specific persistence.
 *
 * Op shape: { op: 'set', path: '', newValue }
 *   path:'' is the empty-root semantic — applyEdits would silently no-op
 *   on this in lodash-style engines, so commitLive is expected to handle
 *   it as "replace whole live state with newValue".
 *
 * Drift detection: fingerprint is sha256(canonicalJson(snapshot)). If
 * the popup's live state changed between propose and approve, fingerprints
 * diverge and the bus parks the entry in conflict.
 */

import { sha256OfJson } from '../fingerprint.js';

function defaultLabel() { return 'Profile change'; }
function defaultIcon() { return '✏'; }
function defaultTarget() { return ''; }

function defaultRenderDiff(_before, _after, helpers) {
    const t = helpers && typeof helpers.i18n === 'function' ? helpers.i18n : (s) => String(s ?? '');
    return `<div class="iter_proposal_diff_placeholder">${t('Profile change — no diff renderer registered')}</div>`;
}

export function createProfileEditHandler(opts = {}) {
    if (!opts || typeof opts.commitLive !== 'function') {
        throw new Error('createProfileEditHandler: commitLive is required');
    }
    if (typeof opts.readLive !== 'function') {
        throw new Error('createProfileEditHandler: readLive is required');
    }
    const commitLive = opts.commitLive;
    const readLive = opts.readLive;
    const renderDiff = typeof opts.renderDiff === 'function' ? opts.renderDiff : defaultRenderDiff;
    const label = typeof opts.label === 'function' ? opts.label : defaultLabel;
    const icon = typeof opts.icon === 'function' ? opts.icon : defaultIcon;
    const target = typeof opts.target === 'function' ? opts.target : defaultTarget;

    async function fingerprint(snapshot) {
        return sha256OfJson(snapshot ?? null);
    }

    async function readCurrent(_op, ctx) {
        const snapshot = readLive(ctx);
        return { snapshot, fingerprint: await fingerprint(snapshot) };
    }

    async function commit(op) {
        const newValue = op && Object.prototype.hasOwnProperty.call(op, 'newValue')
            ? op.newValue
            : undefined;
        await commitLive(newValue);
    }

    function inverse(_op, snapshot) {
        if (snapshot === undefined) return null;
        return { op: 'set', path: '', newValue: snapshot };
    }

    function renderDiffCard(entry, helpers) {
        const before = entry?.snapshot;
        const after = entry?.op && Object.prototype.hasOwnProperty.call(entry.op, 'newValue')
            ? entry.op.newValue
            : undefined;
        return renderDiff(before, after, helpers || {});
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
