/**
 * Chat conflict grouping.
 *
 * A chat file is JSONL: an optional group metadata line followed by
 * messages. Messages align by send_date when every message has a unique
 * one; otherwise position is the only honest identity.
 */

import { collectChanges } from './changes.js';
import { chatFieldLabel } from './labels.js';
import { renderChange } from './render-change.js';

/**
 * @param {string} text
 * @returns {{ metadata: object | null, messages: object[] } | null}
 */
export function parseChat(text) {
    const lines = String(text ?? '').split('\n').filter(line => line.trim() !== '');
    const parsed = [];
    for (const line of lines) {
        try {
            const value = JSON.parse(line);
            if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
            parsed.push(value);
        } catch {
            return null;
        }
    }
    if (parsed.length === 0) return { metadata: null, messages: [] };
    const first = parsed[0];
    const metadata = Object.hasOwn(first, 'chat_metadata') && !Object.hasOwn(first, 'mes') ? first : null;
    return {
        metadata,
        messages: metadata ? parsed.slice(1) : parsed,
    };
}

function firstLine(value) {
    if (typeof value !== 'string') return '';
    return value.trim().split('\n')[0].trim();
}

function messageLabel(item) {
    const message = item.after ?? item.before ?? {};
    const name = typeof message.name === 'string' ? message.name.trim() : '';
    const line = firstLine(message.mes);
    const label = name && line ? `${name}: ${line}` : name || line || `#${item.key}`;
    return label.length > 60 ? label.slice(0, 60) : label;
}

function messageEntry(item, builder) {
    const children = (item.children ?? []).map(child => renderChange(child, builder, {
        label: chatFieldLabel(child.key),
        labelFor: chatFieldLabel,
    }));
    if (children.length === 0 && !item.move) return null;
    return builder.item({
        label: messageLabel(item),
        translateLabel: false,
        status: item.status,
        children,
        move: item.move,
    });
}

/**
 * @param {string} leftText
 * @param {string} rightText
 * @param {ReturnType<import('./tree.js').createBuilder>} builder
 * @returns {object[] | null} null when either side is not a chat, so the caller can use the text renderer
 */
export function renderChat(leftText, rightText, builder) {
    const left = parseChat(leftText);
    const right = parseChat(rightText);
    if (!left || !right) return null;

    const sections = [];
    if (left.metadata || right.metadata) {
        const change = collectChanges(left.metadata ?? {}, right.metadata ?? {});
        if (change) {
            sections.push(builder.section({
                label: 'Chat metadata',
                children: change.children.map(child => renderChange(child, builder, {
                    label: chatFieldLabel(child.key),
                    labelFor: chatFieldLabel,
                })),
            }));
        }
    }

    const messages = collectChanges(left.messages, right.messages, {
        path: 'messages',
        idFields: ['send_date'],
    });
    if (messages) {
        const children = messages.children.map(item => messageEntry(item, builder)).filter(Boolean);
        if (children.length > 0) sections.push(builder.section({ label: 'Messages', children }));
    }
    return sections;
}
