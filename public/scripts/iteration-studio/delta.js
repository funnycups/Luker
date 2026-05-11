/**
 * IterationStudio — profile delta helpers (jsondiffpatch wrapper).
 *
 * The shell owns one default patcher with a permissive objectHash heuristic.
 * Adapters that need different array-move detection (matching by a custom
 * field, ignoring order, etc.) can ship their own patcher via the optional
 * `diffPatcher` field on the adapter object.
 */

import { create as createDiffPatcher, reverse as reverseDiffDelta } from '../vendor/diffpatch/index.js';
import { renderObjectDiffHtml } from '../extensions/object-diff-view.js';
import { DiffMatchPatch } from '../../lib.js';
import { renderInlineTextDiffHtml } from './inline-text-diff.js';

const DEFAULT_TEXT_DIFF_MIN_LENGTH = 80;

function defaultObjectHash(obj, index = 0) {
    if (!obj || typeof obj !== 'object') {
        return `${typeof obj}:${String(obj)}`;
    }
    const id = String(obj.id ?? '').trim();
    if (id) return `id:${id}`;
    const name = String(obj.name ?? '').trim();
    if (name) return `name:${name}`;
    try {
        return JSON.stringify(obj);
    } catch {
        return `index:${index}`;
    }
}

const defaultPatcher = createDiffPatcher({
    objectHash: defaultObjectHash,
    arrays: { detectMove: true, includeValueOnMove: false },
    textDiff: { minLength: DEFAULT_TEXT_DIFF_MIN_LENGTH, diffMatchPatch: DiffMatchPatch },
    cloneDiffValues: true,
});

function getPatcher(adapter) {
    return (adapter && adapter.diffPatcher) || defaultPatcher;
}

function cloneDelta(delta) {
    if (!delta || typeof delta !== 'object') {
        return null;
    }
    return structuredClone(delta);
}

export function buildProfileDelta(adapter, beforeProfile, afterProfile) {
    const safeBefore = adapter.cloneWorkingProfile(beforeProfile);
    const safeAfter = adapter.cloneWorkingProfile(afterProfile);
    const patcher = getPatcher(adapter);
    const delta = patcher.diff(safeBefore, safeAfter);
    const normalized = cloneDelta(delta);
    return {
        beforeProfile: safeBefore,
        afterProfile: safeAfter,
        delta: normalized,
        reverseDelta: normalized ? cloneDelta(reverseDiffDelta(normalized)) : null,
    };
}

function sanitizeDiffHtml(html) {
    return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

/**
 * Default per-message delta renderer. Adapters can override via the optional
 * `renderMessageDiff(session, message, popupId)` adapter method if they need
 * a fully custom view (e.g., a custom layout). For per-leaf tweaks (inline
 * word-level text diff, custom path labels) adapters should set the
 * `renderTextDiff` / `formatDiffPathLabel` adapter fields and let this
 * default renderer thread them through to `renderObjectDiffHtml`.
 */
export function renderProfileDeltaHtml(adapter, delta, beforeProfile, { beforeLabel = 'Before', afterLabel = 'After', missingLabel = '(missing)' } = {}) {
    const normalized = cloneDelta(delta);
    if (!normalized) {
        return '';
    }
    try {
        const safeBefore = adapter.cloneWorkingProfile(beforeProfile);
        const safeAfter = adapter.cloneWorkingProfile(safeBefore);
        getPatcher(adapter).patch(safeAfter, cloneDelta(normalized));
        const html = renderObjectDiffHtml({
            before: safeBefore,
            after: safeAfter,
            delta: normalized,
            beforeLabel,
            afterLabel,
            missingLabel,
            renderTextDiff: typeof adapter.renderTextDiff === 'function' ? adapter.renderTextDiff : renderInlineTextDiffHtml,
            pathLabelFormatter: typeof adapter.formatDiffPathLabel === 'function' ? adapter.formatDiffPathLabel : null,
            renderItem: typeof adapter.renderDiffItem === 'function' ? adapter.renderDiffItem : null,
            // Auto-recurse object replacements so an entire preset / stage /
            // schema-entry swap becomes per-field cards instead of two big
            // JSON blobs. Adapters can still preempt this via renderDiffItem
            // for paths they want to render specially.
            expandObjectItems: true,
        });
        return sanitizeDiffHtml(html);
    } catch (error) {
        console.warn('[iteration-studio] Failed to render profile delta', error);
        return '';
    }
}
