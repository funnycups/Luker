/**
 * Secret conflict grouping.
 *
 * Secret values never leave the server. The documents are masked before
 * they are compared, so every resolver and every value page sees only
 * the masked form. Key names, ids, labels and active flags stay readable
 * so two entries can still be told apart.
 */

import { collectChanges } from './changes.js';
import { humanizeKey } from './labels.js';
import { renderChange } from './render-change.js';

const VISIBLE_KEYS = new Set(['id', 'label', 'active']);

function maskSecretValue(value) {
    if (value.length === 0) return '';
    if (value.length <= 8) return '*'.repeat(8);
    return `${'*'.repeat(8)}${value.slice(-4)}`;
}

/**
 * @param {unknown} document
 * @param {string} [key]
 * @returns {unknown}
 */
export function maskSecretsDocument(document, key = '') {
    if (typeof document === 'string') {
        return VISIBLE_KEYS.has(key) ? document : maskSecretValue(document);
    }
    if (Array.isArray(document)) return document.map(item => maskSecretsDocument(item));
    if (document && typeof document === 'object') {
        return Object.fromEntries(Object.entries(document).map(([childKey, value]) => [childKey, maskSecretsDocument(value, childKey)]));
    }
    return document;
}

function secretItemLabel(item) {
    const value = item.after ?? item.before ?? {};
    return value.label || value.id || String(item.key);
}

/**
 * Compare raw values so a changed secret is still a change even when its
 * last four characters happen to match, then replace every value in the
 * change tree with its masked form. The raw tree never reaches the
 * builder or the value route.
 */
function maskChangeTree(change) {
    if (change.before !== undefined) change.before = maskSecretsDocument(change.before, String(change.key ?? ''));
    if (change.after !== undefined) change.after = maskSecretsDocument(change.after, String(change.key ?? ''));
    for (const child of change.children ?? []) maskChangeTree(child);
}

/**
 * @param {object} left
 * @param {object} right
 * @param {ReturnType<import('./tree.js').createBuilder>} builder
 */
export function renderSecrets(left, right, builder) {
    const change = collectChanges(left, right);
    if (!change) return [];
    maskChangeTree(change);

    const children = change.type === 'object'
        ? (change.children ?? []).map(child => renderChange(child, builder, {
            label: humanizeKey(child.key),
            labelFor: humanizeKey,
            itemLabel: secretItemLabel,
            translateItemLabel: false,
        }))
        : [renderChange(change, builder, {
            label: 'Value',
            labelFor: humanizeKey,
            itemLabel: secretItemLabel,
            translateItemLabel: false,
        })];

    return children.length > 0 ? [builder.section({ label: 'Keys', children })] : [];
}
