// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Character-bound preset read tools shared by iter popups (orchestrator
 * iter-studio, character-editor-assistant editor, and any future iter
 * popup that lets an AI shape a card-bound artifact).
 *
 * Why shared: each popup's AI benefits from being able to inspect the
 * presets already embedded on the active card. An orchestrator agent
 * that references a preset name should verify the preset actually rides
 * on the card; a CEA editor iterating on `system_prompt` may want to
 * cross-check parameters (temperature, top_p, ...) in the paired preset.
 *
 * Architecture: plugin-agnostic. `runCharacterPresetReadTool` needs the
 * SillyTavern context (for `character.presets.list` / `character.presets.get`
 * — the Task 2 ctx surface that lifts Layer 1) plus the target avatar —
 * no per-plugin helper-api injection.
 *
 * Layer 1 already strips OpenAI-connection fields on read
 * (`stripOpenAIConnectionFieldsFromPreset` in `character/presets.js`) so
 * the tool passes results through without a second strip.
 *
 * Error envelope: mirrors `runLorebookReadTool` — every failure returns
 * `{ ok:false, reason, hint, error }` where `reason` is a
 * `STATE_ERROR_REASONS` enum value so consumers (and unit tests) can
 * switch on structure instead of regexing the human-readable `error`
 * string. `hint` is a short (≤120 char) recovery pointer for the AI.
 *
 * Exports:
 *   - CHARACTER_PRESET_READ_TOOL_NAMES — canonical short names the AI sees.
 *   - isCharacterPresetReadTool(name): boolean — runtime predicate for
 *     consumers to route tool_calls into this executor.
 *   - CHARACTER_PRESET_READ_TOOL_DEFS — OpenAI-style function definitions
 *     ready to splice into a popup's tool catalog.
 *   - runCharacterPresetReadTool(call, { context, avatar }): runs one
 *     tool call. Returns `{ ok: true, result }` or
 *     `{ ok: false, reason, hint, error }` so consumers can persist a
 *     tool_result either way (matching the `runLorebookReadTool` contract).
 */

import { STATE_ERROR_REASONS, STATE_HINT_MAX_LENGTH } from '../../state-errors.js';

function makeFailure(reason, hint, error) {
    const safeHint = String(hint == null ? '' : hint).slice(0, STATE_HINT_MAX_LENGTH);
    return { ok: false, reason, hint: safeHint, error: String(error || hint || reason) };
}

const TOOL_NAMES = Object.freeze({
    INSPECT: 'inspect_bound_preset',
});

export const CHARACTER_PRESET_READ_TOOL_NAMES = Object.freeze(Object.values(TOOL_NAMES));

const NAME_SET = new Set(CHARACTER_PRESET_READ_TOOL_NAMES);

export function isCharacterPresetReadTool(name) {
    return NAME_SET.has(String(name || ''));
}

export const CHARACTER_PRESET_READ_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: TOOL_NAMES.INSPECT,
            description: 'Inspect presets embedded on the active character card. action="list" returns every card-bound preset name with isDefault + hasBody flags. action="get" fetches one preset by name and returns { name, preset } (or null when the name is not on the card). Card-bound presets live on the card at data.extensions.luker.chat_completion_preset — this tool does not read global user presets.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['list', 'get'],
                        description: 'Required. "list" enumerates every card-bound preset name. "get" returns one preset\'s body.',
                    },
                    name: {
                        type: 'string',
                        description: 'Required when action="get". Card-bound preset name to fetch.',
                    },
                },
                required: ['action'],
                additionalProperties: false,
            },
        },
    },
];

function resolveCharacterByAvatar(context, avatar) {
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const preferredAvatar = String(avatar || '').trim();
    if (preferredAvatar) {
        return characters.find(item => String(item?.avatar || '').trim() === preferredAvatar) || null;
    }
    // No avatar provided → fall back to context.characterId (matches the
    // resolveCharacterByAvatar helper in _lorebook-helpers.js so behaviour
    // stays consistent across the two shared executors).
    return characters[context?.characterId] || null;
}

/**
 * Execute one character-preset read tool.
 *
 * @param {{id?: string, name: string, args?: object}} call
 *   Parsed tool-call object as delivered by the iteration-library runner.
 * @param {{context: object, avatar?: string}} env
 *   `context` = SillyTavern context (from `Luker.getContext()`),
 *   `avatar`  = character avatar; when omitted, falls back to
 *   `context.characterId`.
 * @returns {Promise<
 *   {ok: true, result: any} |
 *   {ok: false, reason: string, hint: string, error: string}
 * >}
 */
export async function runCharacterPresetReadTool(call, { context, avatar = '' } = {}) {
    const name = String(call?.name || '');
    if (!isCharacterPresetReadTool(name)) {
        const hint = `Not a character-preset read tool: ${name || '(empty)'}`;
        return makeFailure(STATE_ERROR_REASONS.VALIDATION_ARGS, hint, hint);
    }
    if (!context || typeof context !== 'object') {
        const hint = 'runCharacterPresetReadTool: context is required';
        return makeFailure(STATE_ERROR_REASONS.VALIDATION_ARGS, hint, hint);
    }
    const presetsApi = context?.character?.presets;
    if (!presetsApi || typeof presetsApi.list !== 'function' || typeof presetsApi.get !== 'function') {
        const hint = 'runCharacterPresetReadTool: context.character.presets.list/get is not available';
        return makeFailure(STATE_ERROR_REASONS.VALIDATION_ARGS, hint, hint);
    }
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    const action = String(args.action || '').trim();
    if (!action) {
        const hint = 'inspect_bound_preset: action is required (list|get)';
        return makeFailure(STATE_ERROR_REASONS.VALIDATION_ARGS, hint, hint);
    }
    const character = resolveCharacterByAvatar(context, avatar);
    if (!character) {
        const trimmedAvatar = String(avatar || '').trim();
        const suffix = trimmedAvatar ? ` for avatar "${trimmedAvatar}"` : '';
        const hint = `inspect_bound_preset: character not found${suffix}`;
        return makeFailure(STATE_ERROR_REASONS.VALIDATION_TARGET, hint, hint);
    }

    try {
        if (name === TOOL_NAMES.INSPECT) {
            if (action === 'list') {
                const list = presetsApi.list(character) || [];
                return {
                    ok: true,
                    result: list.map(entry => ({
                        name: entry?.name,
                        isDefault: Boolean(entry?.isDefault),
                        hasBody: Boolean(entry?.preset),
                    })),
                };
            }
            if (action === 'get') {
                const presetName = String(args.name || '').trim();
                if (!presetName) {
                    const hint = 'inspect_bound_preset: action=get requires a name argument';
                    return makeFailure(STATE_ERROR_REASONS.VALIDATION_ARGS, hint, hint);
                }
                const hit = presetsApi.get(character, presetName);
                return { ok: true, result: hit || null };
            }
            const hint = `inspect_bound_preset: unknown action "${action}" (expected list|get)`;
            return makeFailure(STATE_ERROR_REASONS.VALIDATION_ARGS, hint, hint);
        }
        const hint = `Unhandled character-preset read tool: ${name}`;
        return makeFailure(STATE_ERROR_REASONS.VALIDATION_ARGS, hint, hint);
    } catch (err) {
        const message = String(err?.message || err || 'unknown error');
        return makeFailure(STATE_ERROR_REASONS.TRANSPORT_ERROR, message, message);
    }
}
