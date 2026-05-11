// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { escapeHtml } from '../utils.js';
import { extractJsonStateTouchedPaths, tokenizeJsonPath } from './json-state-journal.js';

function stableStringify(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (value === undefined) {
        return '';
    }
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function valuesEqual(left, right) {
    return stableStringify(left) === stableStringify(right);
}

function isStructuredValue(value) {
    return value !== null && typeof value === 'object';
}

function getValueAtJsonPath(source, path) {
    const segments = tokenizeJsonPath(path);
    let current = source;
    for (const segment of segments) {
        if (current === null || current === undefined) {
            return undefined;
        }
        current = current[segment];
    }
    return current;
}

function formatDiffValue(value, missingLabel = '(missing)') {
    if (value === undefined) {
        return {
            text: String(missingLabel || '(missing)'),
            missing: true,
        };
    }
    return {
        text: stableStringify(value),
        missing: false,
    };
}

function shouldRenderTextDiff(beforeValue, afterValue, beforeText, afterText) {
    if (isStructuredValue(beforeValue) || isStructuredValue(afterValue)) {
        return true;
    }
    return beforeText.includes('\n')
        || afterText.includes('\n')
        || Math.max(beforeText.length, afterText.length) >= 160;
}

function isAncestorPath(leftPath, rightPath) {
    const leftSegments = tokenizeJsonPath(leftPath);
    const rightSegments = tokenizeJsonPath(rightPath);
    if (leftSegments.length === 0 || leftSegments.length >= rightSegments.length) {
        return false;
    }
    return leftSegments.every((segment, index) => segment === rightSegments[index]);
}

function pruneAncestorPaths(paths) {
    const safePaths = Array.isArray(paths) ? paths.filter(Boolean) : [];
    return safePaths.filter((path) => !safePaths.some((otherPath) => otherPath !== path && isAncestorPath(path, otherPath)));
}

function buildObjectDiffItems(before, after, delta) {
    const touchedPaths = pruneAncestorPaths(extractJsonStateTouchedPaths(delta));
    if (touchedPaths.length === 0) {
        if (valuesEqual(before, after)) {
            return [];
        }
        return [{
            path: '(root)',
            beforeValue: before,
            afterValue: after,
        }];
    }
    return touchedPaths.map((path) => ({
        path,
        beforeValue: getValueAtJsonPath(before, path),
        afterValue: getValueAtJsonPath(after, path),
    })).filter((item) => !valuesEqual(item.beforeValue, item.afterValue));
}

/**
 * Recursively expand items whose before/after are both plain objects into
 * one item per changed inner field. Avoids "two big JSON blocks side by
 * side" when an entire sub-object gets replaced.
 *
 * Off by default in `renderObjectDiffHtml`; iteration-studio's
 * `renderProfileDeltaHtml` opts in via the `expandObjectItems` parameter.
 */
function expandObjectDiffItemsRecursively(items, maxDepth = 3) {
    const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const recurse = (item, depth) => {
        if (depth >= maxDepth) {
            return [item];
        }
        const { path, beforeValue, afterValue } = item;
        if (!isPlainObject(beforeValue) || !isPlainObject(afterValue)) {
            return [item];
        }
        const allKeys = new Set([...Object.keys(beforeValue), ...Object.keys(afterValue)]);
        const subItems = [];
        for (const key of allKeys) {
            const subBefore = beforeValue[key];
            const subAfter = afterValue[key];
            if (valuesEqual(subBefore, subAfter)) {
                continue;
            }
            const subPath = path === '(root)' ? String(key) : `${path}.${key}`;
            subItems.push(...recurse({
                path: subPath,
                beforeValue: subBefore,
                afterValue: subAfter,
            }, depth + 1));
        }
        // If the object had no comparable inner changes after equality
        // filtering, fall back to showing the original item rather than
        // emitting nothing.
        return subItems.length > 0 ? subItems : [item];
    };
    return (Array.isArray(items) ? items : []).flatMap((item) => recurse(item, 0));
}

export function renderObjectDiffHtml({
    before = {},
    after = {},
    delta = null,
    beforeLabel = 'Before',
    afterLabel = 'After',
    missingLabel = '(missing)',
    emptyLabel = '',
    renderTextDiff = null,
    pathLabelFormatter = null,
    renderItem = null,
    expandObjectItems = false,
} = {}) {
    if (!delta || typeof delta !== 'object') {
        return '';
    }

    const rawItems = buildObjectDiffItems(before, after, delta);
    const items = expandObjectItems
        ? expandObjectDiffItemsRecursively(rawItems)
        : rawItems;
    if (items.length === 0) {
        return '';
    }

    const safeBeforeLabel = escapeHtml(String(beforeLabel || 'Before'));
    const safeAfterLabel = escapeHtml(String(afterLabel || 'After'));
    const safeEmptyLabel = escapeHtml(String(emptyLabel || ''));
    const safeMissingLabel = String(missingLabel || '(missing)');

    return `
<div class="luker_object_diff">
    ${items.map((item) => {
        const formattedPathLabel = typeof pathLabelFormatter === 'function'
            ? pathLabelFormatter(String(item?.path || '(root)'), item)
            : String(item?.path || '(root)');
        const pathLabel = escapeHtml(String(formattedPathLabel || item?.path || '(root)'));
        const beforeValue = item?.beforeValue;
        const afterValue = item?.afterValue;
        const beforePayload = formatDiffValue(beforeValue, safeMissingLabel);
        const afterPayload = formatDiffValue(afterValue, safeMissingLabel);

        // Caller-provided full-item override takes precedence. Useful for
        // adapters that want to render an entire diff card with custom
        // logic (e.g., recursing into an object replacement instead of
        // showing two big <pre> blobs side by side).
        if (typeof renderItem === 'function') {
            const customBody = renderItem({
                path: String(item?.path || '(root)'),
                beforeValue,
                afterValue,
                beforePayload,
                afterPayload,
            });
            if (customBody) {
                return `
    <div class="luker_object_diff_item">
        <div class="luker_object_diff_path">${pathLabel}</div>
        ${customBody}
    </div>`;
            }
        }

        const beforeTextForDiff = beforePayload.missing ? '' : beforePayload.text;
        const afterTextForDiff = afterPayload.missing ? '' : afterPayload.text;
        const textDiffHtml = typeof renderTextDiff === 'function' && shouldRenderTextDiff(beforeValue, afterValue, beforeTextForDiff, afterTextForDiff)
            ? renderTextDiff(beforeTextForDiff, afterTextForDiff, String(item?.path || '(root)'))
            : '';
        const beforeContent = beforePayload.missing
            ? `<div class="luker_object_diff_missing">${escapeHtml(beforePayload.text)}</div>`
            : `<pre>${escapeHtml(beforePayload.text || safeEmptyLabel)}</pre>`;
        const afterContent = afterPayload.missing
            ? `<div class="luker_object_diff_missing">${escapeHtml(afterPayload.text)}</div>`
            : `<pre>${escapeHtml(afterPayload.text || safeEmptyLabel)}</pre>`;
        return `
    <div class="luker_object_diff_item">
        <div class="luker_object_diff_path">${pathLabel}</div>
        ${textDiffHtml ? `
        <div class="luker_object_diff_text">${textDiffHtml}</div>
        ` : `
        <div class="luker_object_diff_grid">
            <div class="luker_object_diff_col before">
                <div class="luker_object_diff_col_title">${safeBeforeLabel}</div>
                ${beforeContent}
            </div>
            <div class="luker_object_diff_col after">
                <div class="luker_object_diff_col_title">${safeAfterLabel}</div>
                ${afterContent}
            </div>
        </div>
        `}
    </div>`;
    }).join('')}
</div>`;
}
