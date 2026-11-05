/**
 * Generic JSON conflict grouping.
 *
 * Settings and unknown JSON files get one section per changed top-level
 * key. Nested objects become entries, so a deep settings tree stays
 * navigable without printing dotted paths.
 */

import { collectChanges } from './changes.js';
import { humanizeKey } from './labels.js';
import { renderChange } from './render-change.js';

function valueField(change, builder) {
    return builder.field({
        label: 'Value',
        translateLabel: true,
        status: change.status,
        before: change.before,
        after: change.after,
    });
}

function itemLabel(change) {
    return typeof change.key === 'number' ? `#${change.key}` : String(change.key);
}

function sectionChildren(change, builder) {
    if (change.type === 'field') return [valueField(change, builder)];
    if (change.type === 'object' || change.type === 'array') {
        return (change.children ?? []).map(child => {
            if (child.type === 'item') {
                return renderChange(child, builder, {
                    label: itemLabel(child),
                    translateLabel: false,
                    labelFor: humanizeKey,
                });
            }
            return renderChange(child, builder, {
                label: humanizeKey(child.key),
                labelFor: humanizeKey,
            });
        });
    }
    return [renderChange(change, builder, { label: humanizeKey(change.key), labelFor: humanizeKey })];
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @param {ReturnType<import('./tree.js').createBuilder>} builder
 * @param {{ sectionLabel?: string }} [options]
 */
export function renderGeneric(left, right, builder, { sectionLabel = 'Changes' } = {}) {
    const change = collectChanges(left, right);
    if (!change) return [];

    if (change.type !== 'object') {
        return [builder.section({ label: sectionLabel, translateLabel: true, children: sectionChildren(change, builder) })];
    }

    const sections = [];
    for (const child of change.children ?? []) {
        const label = humanizeKey(child.key);
        const children = child.type === 'field'
            ? [valueField(child, builder)]
            : child.type === 'object' || child.type === 'array'
                ? sectionChildren(child, builder)
                : [renderChange(child, builder, { label, labelFor: humanizeKey })];
        if (children.length > 0) sections.push(builder.section({ label, translateLabel: true, children }));
    }
    return sections;
}
