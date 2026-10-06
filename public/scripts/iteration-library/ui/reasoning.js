// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Reasoning / thinking extraction for iteration-studio message cards.
 *
 * Pure helpers — no DOM, no i18n, no ST context. The shared renderer
 * (`message.js`) uses `resolveAssistantDisplay` so every studio shows one
 * unified think block regardless of which source the assistant turn
 * carries:
 *   1. a separate `reasoning` string,
 *   2. `reasoningBlocks` / `reasoningDetails` arrays,
 *   3. literal think / thought tag pairs in the body.
 */

const DEFAULT_THINK_TAGS = ['think', 'thought'];

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function splitThinkTags(text, tagNames = DEFAULT_THINK_TAGS) {
    const source = String(text ?? '');
    const tags = (Array.isArray(tagNames) ? tagNames : DEFAULT_THINK_TAGS)
        .map(tag => String(tag || '').trim())
        .filter(Boolean);
    const blocks = [];
    if (!source || tags.length === 0) {
        return { body: source, blocks };
    }
    const alternation = tags.map(escapeRegExp).join('|');
    const pattern = new RegExp(`<(${alternation})>([\\s\\S]*?)<\\/\\1>`, 'gi');
    const body = source.replace(pattern, (_match, _tag, inner) => {
        const trimmed = String(inner).trim();
        if (trimmed) blocks.push(trimmed);
        return '';
    });
    return { body, blocks };
}

function textFromReasoningBlocks(blocks) {
    if (!Array.isArray(blocks)) return '';
    return blocks
        .map((block) => {
            if (!block || typeof block !== 'object') return '';
            if (typeof block.thinking === 'string') return block.thinking;
            if (typeof block.text === 'string') return block.text;
            return '';
        })
        .filter(Boolean)
        .join('\n\n');
}

function textFromReasoningDetails(details) {
    if (!Array.isArray(details)) return '';
    return details
        .map((detail) => {
            if (!detail || typeof detail !== 'object') return '';
            if (typeof detail.text === 'string') return detail.text;
            if (typeof detail.summary === 'string') return detail.summary;
            return '';
        })
        .filter(Boolean)
        .join('\n\n');
}

export function collectReasoning(message) {
    if (!message || typeof message !== 'object') return '';
    const direct = typeof message.reasoning === 'string' ? message.reasoning.trim() : '';
    if (direct) return direct;
    const fromBlocks = textFromReasoningBlocks(message.reasoningBlocks);
    const fromDetails = textFromReasoningDetails(message.reasoningDetails);
    const combined = [fromBlocks, fromDetails].filter(Boolean).join('\n\n');
    if (combined) return combined;
    return splitThinkTags(String(message.content ?? '')).blocks.join('\n\n');
}

export function resolveAssistantDisplay(message) {
    const content = String(message?.content ?? '');
    return {
        body: splitThinkTags(content).body,
        reasoning: collectReasoning(message),
    };
}
