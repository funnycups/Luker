// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

/**
 * Identifiers of prompt slots whose content ST overwrites with raw
 * character / persona / world info / chat text during
 * `preparePromptsForChatCompletion`. The director runtime already
 * delivers all of this via the cached content payload built from the
 * user's preset, so if the user-selected director agent preset ALSO
 * has any of these slots enabled with non-empty text, that content
 * is duplicated in the outgoing request.
 *
 * This list mirrors the content-shaped slots populated by the
 * skeleton preset (see `director-skeleton-preset.js`). `chatHistory`
 * is a marker slot (no `content` field) and is treated as
 * content-bearing whenever the marker is enabled.
 */
export const DIRECTOR_CONTENT_PROMPT_IDENTIFIERS = new Set([
    'charDescription',
    'charPersonality',
    'personaDescription',
    'scenario',
    'worldInfoBefore',
    'worldInfoAfter',
    'chatHistory',
]);

/**
 * Returns true if the given chat-completion preset has any
 * content-shaped prompt items (character / persona / scenario / WI /
 * chatHistory) enabled with non-empty content. Used by the director
 * profile UI to surface a passive lint warning that the selected
 * preset will duplicate director's content payload.
 *
 * Pure-instruction presets (only `main` / `jailbreak` / `nsfw` /
 * `enhanceDefinitions` enabled) return false. So do presets where
 * the content slots are disabled or have empty content.
 *
 * Resilient against malformed input: `null`, `undefined`, missing
 * `prompts`, non-array `prompts`, or entries that are not plain
 * objects all yield `false`.
 *
 * @param {object|null|undefined} preset
 * @returns {boolean}
 */
export function presetContainsContentPrompts(preset) {
    if (!preset || typeof preset !== 'object') return false;
    if (!Array.isArray(preset.prompts)) return false;
    return preset.prompts.some(p => {
        if (!p || typeof p !== 'object') return false;
        if (!DIRECTOR_CONTENT_PROMPT_IDENTIFIERS.has(p.identifier)) return false;
        if (!p.enabled) return false;
        // chatHistory marker has no `content` field; presence alone counts.
        if (p.marker) return true;
        return typeof p.content === 'string' && p.content.length > 0;
    });
}
