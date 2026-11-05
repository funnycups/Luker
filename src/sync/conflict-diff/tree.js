/**
 * Build the serializable conflict navigation tree.
 *
 * Nodes carry labels, statuses and value metadata. Value text lives only
 * in resolvers held by a WeakMap, so JSON.stringify(sections) can never
 * leak a value into the diff response.
 */

import { displayValue, lineRows, valueMeta, withContext } from './values.js';

function baseNode(type, { label, translateLabel = true, status = 'changed', meta, value, children }) {
    const node = {
        type,
        label,
        translateLabel: translateLabel !== false,
        status,
    };
    if (children !== undefined) node.children = children;
    if (value !== undefined) node.value = value;
    if (meta !== undefined) node.meta = meta;
    return node;
}

export function createBuilder() {
    const resolvers = new WeakMap();

    const section = ({ label, translateLabel = true, children = [] }) => baseNode('section', {
        label,
        translateLabel,
        status: 'none',
        children,
    });

    const item = ({ label, translateLabel = true, status = 'changed', children = [], move, meta }) => baseNode('item', {
        label,
        translateLabel,
        status,
        children,
        meta: move || meta ? { ...(meta ?? {}), ...(move ? { move } : {}) } : undefined,
    });

    const field = ({ label, translateLabel = true, status = 'changed', before, after }) => {
        const meta = valueMeta(before, after);
        const node = baseNode('field', {
            label,
            translateLabel,
            status,
            value: { kind: meta.kind },
        });
        if (meta.kind === 'text') {
            resolvers.set(node, () => ({ mode: 'lines', rows: withContext(lineRows(before, after)) }));
        } else {
            resolvers.set(node, () => ({
                mode: 'cells',
                before: before === undefined ? undefined : displayValue(before),
                after: after === undefined ? undefined : displayValue(after),
            }));
        }
        return node;
    };

    const lines = ({ label = 'Lines', translateLabel = true, status = 'changed', lines: range, rows }) => {
        const node = baseNode('field', {
            label,
            translateLabel,
            status,
            value: { kind: 'lines' },
            meta: range ? { lines: range } : undefined,
        });
        resolvers.set(node, () => ({ mode: 'lines', rows }));
        return node;
    };

    const finalize = sections => {
        const prune = node => {
            if (node.type !== 'section' && node.type !== 'item') return node;
            const children = (node.children ?? []).map(prune).filter(Boolean);
            node.children = children;
            if (node.type === 'section' && children.length === 0) return null;
            if (node.type === 'item' && children.length === 0 && !node.meta?.move && !['added', 'removed', 'moved'].includes(node.status)) return null;
            return node;
        };

        let nextId = 0;
        const values = new Map();
        const assign = node => {
            node.id = String(nextId++);
            const resolver = resolvers.get(node);
            if (resolver) values.set(node.id, resolver);

            if (node.children !== undefined) node.children.forEach(assign);

            const meta = { ...(node.meta ?? {}) };
            if (node.type === 'field' || (node.children ?? []).length === 0) {
                meta.changed = 1;
                meta.leaves = 1;
            } else {
                meta.changed = node.children.length;
                meta.leaves = node.children.reduce((sum, child) => sum + child.meta.leaves, 0);
            }
            node.meta = meta;
        };

        const pruned = sections.map(prune).filter(Boolean);
        pruned.forEach(assign);
        return { sections: pruned, values };
    };

    return { section, item, field, lines, finalize };
}
