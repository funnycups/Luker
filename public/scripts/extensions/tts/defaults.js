// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Internal default configuration table for the TTS extension.
 */

export const DEFAULT_VOICE_MARKER = '[Default Voice]';
export const DISABLED_VOICE_MARKER = 'disabled';
export const SYSTEM_VOICE_ALIASES = new Set(['Luker System', 'SillyTavern System']);

export const defaultSettings = Object.freeze({
    voiceMap: '',
    currentProvider: 'ElevenLabs',
    auto_generation: true,
    narrate_user: false,
    playback_rate: 1,
    multi_voice_enabled: false,
    apply_regex: false,
    regex_pattern: '',
    npcAttributionEnabled: false,
    npcAttributionApiPresetName: '',
    npcAttributionPresetName: '',
    npcAttributionRetryMax: 2,
});

export const ATTRIBUTION_TOOL_NAME = 'report_dialogue_attribution';

export const ATTRIBUTION_TOOL_PARAMETERS = Object.freeze({
    type: 'object',
    required: ['segments'],
    properties: {
        segments: {
            type: 'array',
            items: {
                type: 'object',
                required: ['quote_text', 'speaker'],
                properties: {
                    quote_text: { type: 'string' },
                    speaker: { type: ['string', 'null'] },
                },
            },
        },
    },
    additionalProperties: false,
});

export const ATTRIBUTION_SYSTEM_PROMPT = [
    'Attribute each quoted line of dialogue in the message to its speaker.',
    'Work only from textual evidence: surrounding narration, action text, and speaker tags.',
    'The message author is a valid speaker. Characters from the roster are valid speakers.',
    'If a name is not on the roster but the text clearly shows who spoke, return that name as written.',
    'When you cannot decide, set speaker to null. Do not guess.',
    'Return one segment per quoted line, in message order, with quote_text matching the quoted text.',
].join('\n');
