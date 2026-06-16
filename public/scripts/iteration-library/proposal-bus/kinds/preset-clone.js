// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * preset-clone KindHandler — wraps the CPA `cloneAndSwitchTarget(newName)`
 * helper so any popup that supports clone-and-switch can stage it as a
 * ProposalBus entry. This is the only kind so far whose semantics are
 * structurally non-rollbackable (the user's open session migrates onto
 * the cloned preset; auto-reversing would have to delete the cloned
 * preset and switch back, which we explicitly do NOT do — `inverse`
 * returns null and `inverseAvailable` is false).
 *
 * Op shape: { sourceName, newName }
 *
 * Snapshot is whatever the popup's `readSourceSnapshot(op)` returns —
 * typically `{ exists, hash, target_taken }`: `exists` = the source preset
 * still exists, `hash` = a content fingerprint that detects external
 * edits to the source between propose and approve, `target_taken` = the
 * newName collided with another preset created in the meantime.
 *
 * Drift / collision is detected via the standard fingerprint compare. The
 * popup decides exactly what fields go in the snapshot — the bus just
 * canonicalizes + hashes whatever shape it receives.
 *
 * Optional `afterClone(op, result)` hook fires after a successful clone
 * so the popup can do its session-bucket migration + UI re-prime work
 * (see CPA's migrateCurrentSessionAcrossClone + loadLive in commit
 * step) without making the bus aware of those subsystems.
 */

import { sha256OfJson } from '../fingerprint.js';

const DEFAULT_LABEL = 'Clone preset';
const DEFAULT_ICON = '⎘';

function defaultRenderDiff(_before, _op, helpers) {
    const t = helpers && typeof helpers.i18n === 'function' ? helpers.i18n : (s) => String(s ?? '');
    return `<div class="iter_proposal_diff_placeholder">${t('Clone preset — no diff renderer registered')}</div>`;
}

export function createPresetCloneHandler(opts = {}) {
    if (!opts || typeof opts.cloneAndSwitchTarget !== 'function') {
        throw new Error('createPresetCloneHandler: cloneAndSwitchTarget is required');
    }
    if (typeof opts.readSourceSnapshot !== 'function') {
        throw new Error('createPresetCloneHandler: readSourceSnapshot is required');
    }
    const cloneAndSwitchTarget = opts.cloneAndSwitchTarget;
    const readSourceSnapshot = opts.readSourceSnapshot;
    const afterClone = typeof opts.afterClone === 'function' ? opts.afterClone : null;
    const renderDiff = typeof opts.renderDiff === 'function' ? opts.renderDiff : defaultRenderDiff;
    const labelFn = typeof opts.label === 'function' ? opts.label : null;
    const iconFn = typeof opts.icon === 'function' ? opts.icon : null;
    const targetFn = typeof opts.target === 'function' ? opts.target : null;

    async function fingerprint(snapshot) {
        return sha256OfJson(snapshot ?? null);
    }

    async function readCurrent(op) {
        const snapshot = await readSourceSnapshot(op);
        return { snapshot, fingerprint: await fingerprint(snapshot) };
    }

    async function commit(op) {
        const newName = op?.newName;
        const result = await cloneAndSwitchTarget(newName);
        if (!result || result.ok === false) {
            const msg = String(result?.error || 'cloneAndSwitchTarget reported failure');
            throw new Error(msg);
        }
        if (afterClone) {
            try {
                await afterClone(op, result);
            } catch (err) {
                // afterClone is best-effort (matches CPA's existing
                // migrateCurrentSessionAcrossClone behaviour — clone has
                // already landed, post-hooks should warn but not fail
                // the bus commit).
                // eslint-disable-next-line no-console
                console.warn('[preset-clone] afterClone hook threw', err);
            }
        }
        return result;
    }

    function inverse() {
        return null;
    }

    function renderDiffCard(entry, helpers) {
        return renderDiff(entry?.snapshot, entry?.op, helpers || {});
    }

    function label(entry) {
        if (labelFn) return labelFn(entry);
        return DEFAULT_LABEL;
    }
    function icon(entry) {
        return iconFn ? iconFn(entry) : DEFAULT_ICON;
    }
    function target(entry) {
        if (targetFn) return targetFn(entry);
        const src = entry?.op?.sourceName ?? '';
        const dst = entry?.op?.newName ?? '';
        if (!src && !dst) return '';
        return `${src} → ${dst}`;
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
        inverseAvailable: false,
    };
}
