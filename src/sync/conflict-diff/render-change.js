/**
 * Map a structural change node onto the view builder.
 *
 * Artifact renderers use this for nested values they do not group
 * themselves; the top-level artifact grouping stays in their own module.
 */

import { humanizeKey } from './labels.js';

const defaultItemLabel = change => (typeof change.key === 'number' ? `#${change.key}` : String(change.key));

/**
 * @param {object} change
 * @param {ReturnType<import('./tree.js').createBuilder>} builder
 * @param {{ label?: string, labelFor?: (key: string) => string, translateLabel?: boolean, itemLabel?: (change: object) => string, translateItemLabel?: boolean }} [options]
 */
export function renderChange(change, builder, {
    label,
    labelFor = humanizeKey,
    translateLabel = true,
    itemLabel = defaultItemLabel,
    translateItemLabel = false,
} = {}) {
    const nodeLabel = label ?? labelFor(change.key);

    if (change.type === 'field') {
        return builder.field({
            label: nodeLabel,
            translateLabel,
            status: change.status,
            before: change.before,
            after: change.after,
        });
    }

    if (change.type === 'item') {
        const children = (change.children ?? []).map(child => renderChange(child, builder, {
            label: child.key === undefined ? undefined : labelFor(child.key),
            labelFor,
            itemLabel,
            translateItemLabel,
        }));
        if (children.length === 0 && !change.move) {
            return builder.field({
                label: nodeLabel,
                translateLabel,
                status: change.status,
                before: change.before,
                after: change.after,
            });
        }
        return builder.item({
            label: nodeLabel,
            translateLabel,
            status: change.status,
            children,
            move: change.move,
        });
    }

    const children = (change.children ?? []).map(child => {
        if (child.type === 'item') {
            return renderChange(child, builder, {
                label: itemLabel(child),
                translateLabel: translateItemLabel,
                labelFor,
                itemLabel,
                translateItemLabel,
            });
        }
        return renderChange(child, builder, { label: labelFor(child.key), labelFor, itemLabel, translateItemLabel });
    });

    return builder.item({
        label: nodeLabel,
        translateLabel,
        status: change.status,
        children,
    });
}
