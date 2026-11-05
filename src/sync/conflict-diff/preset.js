/**
 * Preset conflict grouping.
 *
 * Presets are not one flat JSON object to the user. Parameters, prompts,
 * prompt order and extension state each answer a different question, so
 * each gets its own section and entry vocabulary.
 */

import { collectChanges } from './changes.js';
import { humanizeKey, presetFieldLabel } from './labels.js';
import { renderChange } from './render-change.js';

const SPECIAL_KEYS = new Set(['prompts', 'prompt_order', 'extensions']);

function parametersOf(document) {
    const result = {};
    for (const [key, value] of Object.entries(document ?? {})) {
        if (!SPECIAL_KEYS.has(key)) result[key] = value;
    }
    return result;
}

function promptArray(document) {
    const prompts = document?.prompts;
    if (Array.isArray(prompts)) return prompts;
    if (prompts && typeof prompts === 'object') return Object.values(prompts);
    return [];
}

function normalizePromptOrder(document) {
    const order = document?.prompt_order;
    if (Array.isArray(order)) return order;
    if (order && typeof order === 'object') return Object.values(order);
    return [];
}

function orderArray(group) {
    const order = group?.order;
    if (Array.isArray(order)) return order;
    if (order && typeof order === 'object') return Object.values(order);
    return [];
}

function promptNameMap(left, right) {
    const names = new Map();
    for (const document of [left, right]) {
        for (const prompt of promptArray(document)) {
            if (prompt?.identifier === undefined) continue;
            names.set(String(prompt.identifier), prompt.name || String(prompt.identifier));
        }
    }
    return names;
}

function promptEntry(item, builder) {
    const label = item.after?.name || item.before?.name || String(item.key);
    const children = (item.children ?? []).map(child => renderChange(child, builder, {
        label: presetFieldLabel(child.key),
        labelFor: presetFieldLabel,
    }));
    if (children.length === 0 && !item.move) return null;
    return builder.item({
        label,
        translateLabel: false,
        status: item.status,
        children,
        move: item.move,
    });
}

function renderPrompts(left, right, builder) {
    const change = collectChanges(promptArray(left), promptArray(right), {
        path: 'prompts',
        idFields: ['identifier'],
    });
    if (!change) return [];
    return change.children.map(item => promptEntry(item, builder)).filter(Boolean);
}

function orderEntry(item, builder, names) {
    const identifier = String(item.key);
    const label = names.get(identifier) || identifier;
    const children = (item.children ?? []).map(child => renderChange(child, builder, {
        label: presetFieldLabel(child.key),
        labelFor: presetFieldLabel,
    }));
    if (children.length === 0 && !item.move) return null;
    return builder.item({
        label,
        translateLabel: false,
        status: item.status,
        children,
        move: item.move,
    });
}

function orderGroup(leftGroup, rightGroup, builder, names) {
    const leftMissing = leftGroup === undefined;
    const rightMissing = rightGroup === undefined;
    if (leftMissing && rightMissing) return null;
    const change = collectChanges(
        leftMissing ? [] : orderArray(leftGroup),
        rightMissing ? [] : orderArray(rightGroup),
        { path: 'prompt_order.order', idFields: ['identifier'] },
    );
    const children = (change?.children ?? []).map(item => orderEntry(item, builder, names)).filter(Boolean);
    if (children.length === 0 && !leftMissing && !rightMissing) return null;
    const status = leftMissing ? 'added' : rightMissing ? 'removed' : 'changed';
    const characterId = rightGroup?.character_id ?? leftGroup?.character_id;
    if (characterId === undefined || String(characterId) === '100001') {
        return builder.item({ label: 'Default order', translateLabel: true, status, children });
    }
    return builder.item({
        label: 'Order for character',
        translateLabel: true,
        status,
        children,
        meta: { characterId: String(characterId) },
    });
}

function renderPromptOrder(left, right, builder) {
    const leftGroups = normalizePromptOrder(left);
    const rightGroups = normalizePromptOrder(right);
    const keyOf = group => (group?.character_id === undefined ? null : String(group.character_id));
    const leftKeys = leftGroups.map(keyOf);
    const rightKeys = rightGroups.map(keyOf);
    const canAlign = leftKeys.every(key => key !== null)
        && rightKeys.every(key => key !== null)
        && new Set(leftKeys).size === leftKeys.length
        && new Set(rightKeys).size === rightKeys.length;
    const names = promptNameMap(left, right);
    const nodes = [];

    if (!canAlign) {
        const length = Math.max(leftGroups.length, rightGroups.length);
        for (let index = 0; index < length; index++) {
            const node = orderGroup(leftGroups[index], rightGroups[index], builder, names);
            if (node) nodes.push(node);
        }
        return nodes;
    }

    const leftByKey = new Map(leftGroups.map((group, index) => [leftKeys[index], group]));
    const rightByKey = new Map(rightGroups.map((group, index) => [rightKeys[index], group]));
    const keys = [...leftKeys, ...rightKeys.filter(key => !leftByKey.has(key))];
    for (const key of keys) {
        const node = orderGroup(leftByKey.get(key), rightByKey.get(key), builder, names);
        if (node) nodes.push(node);
    }
    return nodes;
}

function extensionItemLabel(item) {
    return item.after?.scriptName || item.before?.scriptName || (typeof item.key === 'number' ? `#${item.key}` : String(item.key));
}

function extensionChildren(change, builder) {
    if (change.type === 'field') {
        return [builder.field({
            label: 'Value',
            translateLabel: true,
            status: change.status,
            before: change.before,
            after: change.after,
        })];
    }
    if (change.type === 'object') {
        return (change.children ?? []).map(child => renderChange(child, builder, {
            label: presetFieldLabel(child.key),
            labelFor: presetFieldLabel,
        }));
    }
    if (change.type === 'array') {
        return (change.children ?? []).map(child => renderChange(child, builder, {
            label: extensionItemLabel(child),
            translateLabel: false,
            labelFor: presetFieldLabel,
        }));
    }
    return [renderChange(change, builder, { label: extensionItemLabel(change), translateLabel: false, labelFor: presetFieldLabel })];
}

function renderExtensions(left, right, builder) {
    const change = collectChanges(left?.extensions ?? {}, right?.extensions ?? {});
    if (!change) return [];
    return change.children.map(child => {
        const label = humanizeKey(child.key);
        const children = extensionChildren(child, builder);
        if (children.length === 0) {
            children.push(builder.field({
                label: 'Value',
                translateLabel: true,
                status: child.status,
                before: child.before,
                after: child.after,
            }));
        }
        return builder.section({ label, translateLabel: true, children });
    });
}

/**
 * @param {object} left
 * @param {object} right
 * @param {ReturnType<import('./tree.js').createBuilder>} builder
 */
export function renderPreset(left, right, builder) {
    const sections = [];

    const parameters = collectChanges(parametersOf(left), parametersOf(right));
    if (parameters) {
        sections.push(builder.section({
            label: 'Parameters',
            children: parameters.children.map(child => renderChange(child, builder, {
                label: presetFieldLabel(child.key),
                labelFor: presetFieldLabel,
            })),
        }));
    }

    const prompts = renderPrompts(left, right, builder);
    if (prompts.length > 0) sections.push(builder.section({ label: 'Prompts', children: prompts }));

    const order = renderPromptOrder(left, right, builder);
    if (order.length > 0) sections.push(builder.section({ label: 'Prompt order', children: order }));

    sections.push(...renderExtensions(left, right, builder));
    return sections;
}
