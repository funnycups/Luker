// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure live behavioral summary models for TTS (Narration Pipeline & NPC
// Dialogue Attribution). All runtime checks mirror
// public/scripts/extensions/tts/index.js and npc-attribution.js.
// No DOM dependencies.

const NARRATION_SUBFIELDS = Object.freeze([
    'narrateUser',
    'autoGeneration',
    'periodicAutoGeneration',
    'narrateByParagraphs',
    'narrateQuoted',
    'narrateDialogues',
    'narrateTranslatedOnly',
    'skipCodeblocks',
    'skipTags',
    'passAsterisks',
    'multiVoiceEnabled',
    'applyRegex',
    'regexPattern',
    'playbackRate',
]);

const NPC_ATTRIBUTION_SUBFIELDS = Object.freeze([
    'apiPreset',
    'preset',
    'retryMax',
]);

function defaultTranslate(text, key = null) {
    const fn = globalThis.Luker?.getContext?.()?.translate;
    return typeof fn === 'function' ? fn(String(text ?? ''), key) : String(text ?? '');
}

function clampRate(raw, min = 0, max = 3, fallback = 1) {
    const isBlank = raw === '' || raw === null || raw === undefined
        || (typeof raw === 'string' && raw.trim() === '');
    const parsed = isBlank ? NaN : Number(raw);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    const clamped = Math.max(min, Math.min(max, parsed));
    return Math.round(clamped * 100) / 100;
}

function clampNonNegInt(raw, fallback = 2) {
    const isBlank = raw === '' || raw === null || raw === undefined
        || (typeof raw === 'string' && raw.trim() === '');
    const parsed = isBlank ? NaN : Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(0, parsed);
}

/**
 * Card 1: TTS Narration Pipeline summary (enablement, triggers, streaming,
 * playback speed, text filters, multi-voice splitting, and conflicts).
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildTtsNarrationSummary(state = {}) {
    const translate = typeof state.translate === 'function' ? state.translate : defaultTranslate;

    const enabled = Boolean(state.enabled);
    if (!enabled) {
        return {
            tone: 'dormant',
            rows: [{
                role: translate('Status'),
                tone: 'off',
                template: translate('${enabled} — all narration settings below are inactive.'),
                tokens: {
                    enabled: {
                        field: 'enabled',
                        text: translate('TTS is off'),
                        tone: 'off',
                    },
                },
            }],
            warnings: [],
            dormantFields: [...NARRATION_SUBFIELDS],
        };
    }

    const provider = String(state.provider || '').trim();
    const isSystemProvider = provider === 'System';
    const autoGeneration = Boolean(state.autoGeneration);
    const narrateUser = Boolean(state.narrateUser);
    const periodicAutoGeneration = Boolean(state.periodicAutoGeneration);
    const narrateByParagraphs = Boolean(state.narrateByParagraphs);
    const narrateQuoted = Boolean(state.narrateQuoted);
    const narrateDialogues = Boolean(state.narrateDialogues);
    const narrateTranslatedOnly = Boolean(state.narrateTranslatedOnly);
    const skipCodeblocks = Boolean(state.skipCodeblocks);
    const skipTags = Boolean(state.skipTags);
    const passAsterisks = Boolean(state.passAsterisks);
    const multiVoiceEnabled = Boolean(state.multiVoiceEnabled);
    const applyRegex = Boolean(state.applyRegex);
    const playbackRate = clampRate(state.playbackRate, 0, 3, 1);

    const providerToken = {
        field: 'provider',
        text: provider || translate('none selected'),
        tone: provider ? 'active' : 'warn',
    };

    const triggerTokens = {
        autoGeneration: {
            field: 'autoGeneration',
            text: autoGeneration
                ? translate('Auto-narrates new AI replies')
                : translate('Manual narration only'),
            tone: autoGeneration ? 'active' : 'off',
        },
        provider: providerToken,
        narrateByParagraphs: {
            field: 'narrateByParagraphs',
            text: autoGeneration
                ? (narrateByParagraphs
                    ? translate('non-streaming by paragraph')
                    : translate('non-streaming whole reply'))
                : (narrateByParagraphs
                    ? translate('by paragraph')
                    : translate('whole message')),
            tone: narrateByParagraphs ? 'active' : 'off',
        },
    };

    if (autoGeneration) {
        triggerTokens.narrateUser = {
            field: 'narrateUser',
            text: narrateUser
                ? translate('and user messages')
                : translate('skipping user messages'),
            tone: narrateUser ? 'active' : 'off',
        };
        triggerTokens.periodicAutoGeneration = {
            field: 'periodicAutoGeneration',
            text: periodicAutoGeneration
                ? translate('streaming by paragraph')
                : translate('streaming on reply end'),
            tone: periodicAutoGeneration ? 'active' : 'off',
        };
    }

    if (!isSystemProvider) {
        triggerTokens.playbackRate = {
            field: 'playbackRate',
            text: `${playbackRate}×`,
            tone: 'active',
        };
    }

    let triggerTemplate;
    if (autoGeneration) {
        triggerTemplate = isSystemProvider
            ? translate('${autoGeneration} (${narrateUser}) via ${provider} — ${periodicAutoGeneration}, ${narrateByParagraphs}.')
            : translate('${autoGeneration} (${narrateUser}) via ${provider} at ${playbackRate} — ${periodicAutoGeneration}, ${narrateByParagraphs}.');
    } else {
        triggerTemplate = isSystemProvider
            ? translate('${autoGeneration} via ${provider} (${narrateByParagraphs}).')
            : translate('${autoGeneration} via ${provider} at ${playbackRate} (${narrateByParagraphs}).');
    }

    const triggerRow = {
        role: translate('Trigger'),
        template: triggerTemplate,
        tokens: triggerTokens,
    };

    const multiVoiceConflict = multiVoiceEnabled && (!passAsterisks || narrateQuoted);
    const filterTokens = {
        narrateTranslatedOnly: {
            field: 'narrateTranslatedOnly',
            text: narrateTranslatedOnly ? translate('translated text') : translate('raw text'),
            tone: narrateTranslatedOnly ? 'active' : 'off',
        },
        skipCodeblocks: {
            field: 'skipCodeblocks',
            text: skipCodeblocks ? translate('skips codeblocks') : translate('keeps codeblocks'),
            tone: skipCodeblocks ? 'active' : 'off',
        },
        skipTags: {
            field: 'skipTags',
            text: skipTags ? translate('skips <tagged> blocks') : translate('keeps <tagged> blocks'),
            tone: skipTags ? 'active' : 'off',
        },
        passAsterisks: {
            field: 'passAsterisks',
            text: passAsterisks ? translate('passes *asterisks* to TTS') : translate('strips * markers'),
            tone: passAsterisks ? 'active' : 'off',
        },
        applyRegex: {
            field: 'applyRegex',
            text: applyRegex ? translate('applies regex filter') : translate('regex filter off'),
            tone: applyRegex ? 'active' : 'off',
        },
        narrateQuoted: {
            field: 'narrateQuoted',
            text: narrateQuoted ? translate('quotes only') : translate('all remaining text'),
            tone: narrateQuoted ? 'active' : 'off',
        },
        multiVoiceEnabled: {
            field: 'multiVoiceEnabled',
            text: multiVoiceEnabled
                ? translate('splits into multi-voice segments')
                : translate('single voice per speaker'),
            tone: multiVoiceEnabled ? (multiVoiceConflict ? 'warn' : 'active') : 'off',
        },
    };

    if (!passAsterisks) {
        filterTokens.narrateDialogues = {
            field: 'narrateDialogues',
            text: narrateDialogues
                ? translate('drops *text inside asterisks*')
                : translate('keeps text inside asterisks'),
            tone: narrateDialogues ? 'active' : 'off',
        };
    }

    const filterRow = {
        role: translate('Text filter'),
        template: passAsterisks
            ? translate('Reads ${narrateTranslatedOnly} · ${skipCodeblocks} · ${skipTags} · ${passAsterisks} · ${applyRegex} · ${narrateQuoted} · ${multiVoiceEnabled}.')
            : translate('Reads ${narrateTranslatedOnly} · ${skipCodeblocks} · ${skipTags} · ${passAsterisks} (${narrateDialogues}) · ${applyRegex} · ${narrateQuoted} · ${multiVoiceEnabled}.'),
        tokens: filterTokens,
    };

    const warnings = [];
    if (passAsterisks && narrateDialogues) {
        warnings.push({
            severity: 'warn',
            template: translate('${passAsterisks} skips asterisk stripping, making ${narrateDialogues} inactive.'),
            tokens: {
                passAsterisks: {
                    field: 'passAsterisks',
                    text: translate('Pass Asterisks to TTS Engine'),
                    tone: 'warn',
                },
                narrateDialogues: {
                    field: 'narrateDialogues',
                    text: translate('Ignore *text, even "quotes", inside asterisks*', 'Ignore text, even quotes, inside asterisk'),
                    tone: 'warn',
                },
            },
        });
    }
    if (multiVoiceEnabled && !passAsterisks) {
        warnings.push({
            severity: 'warn',
            template: translate('${multiVoiceEnabled} cannot match *text inside asterisks* while ${passAsterisks} is off, because asterisks are stripped before segment splitting.'),
            tokens: {
                multiVoiceEnabled: {
                    field: 'multiVoiceEnabled',
                    text: translate('Different voices for "quotes", *text inside asterisks* and other text', 'Different voices for quotes and text inside asterisks'),
                    tone: 'warn',
                },
                passAsterisks: {
                    field: 'passAsterisks',
                    text: translate('Pass Asterisks to TTS Engine'),
                    tone: 'warn',
                },
            },
        });
    }
    if (multiVoiceEnabled && narrateQuoted) {
        warnings.push({
            severity: 'warn',
            template: translate('${multiVoiceEnabled} loses narration and *asterisk* segments while ${narrateQuoted} is on, because non-quoted text is stripped before splitting.'),
            tokens: {
                multiVoiceEnabled: {
                    field: 'multiVoiceEnabled',
                    text: translate('Different voices for "quotes", *text inside asterisks* and other text', 'Different voices for quotes and text inside asterisks'),
                    tone: 'warn',
                },
                narrateQuoted: {
                    field: 'narrateQuoted',
                    text: translate('Only narrate "quotes"', 'Only narrate quotes'),
                    tone: 'warn',
                },
            },
        });
    }
    if (periodicAutoGeneration && !autoGeneration) {
        warnings.push({
            severity: 'warn',
            template: translate('${periodicAutoGeneration} is inactive while ${autoGeneration} is off.'),
            tokens: {
                periodicAutoGeneration: {
                    field: 'periodicAutoGeneration',
                    text: translate('Narrate by paragraphs (when streaming)'),
                    tone: 'warn',
                },
                autoGeneration: {
                    field: 'autoGeneration',
                    text: translate('Auto Generation'),
                    tone: 'warn',
                },
            },
        });
    }
    if (narrateUser && !autoGeneration) {
        warnings.push({
            severity: 'warn',
            template: translate('${narrateUser} is inactive while ${autoGeneration} is off.'),
            tokens: {
                narrateUser: {
                    field: 'narrateUser',
                    text: translate('Narrate user messages'),
                    tone: 'warn',
                },
                autoGeneration: {
                    field: 'autoGeneration',
                    text: translate('Auto Generation'),
                    tone: 'warn',
                },
            },
        });
    }

    const dormantFields = [];
    if (!autoGeneration) {
        dormantFields.push('narrateUser', 'periodicAutoGeneration');
    }
    if (passAsterisks) {
        dormantFields.push('narrateDialogues');
    }

    return {
        tone: warnings.length > 0 ? 'warn' : 'active',
        rows: [triggerRow, filterRow],
        warnings,
        dormantFields,
    };
}

/**
 * Card 2: TTS NPC Dialogue Attribution summary (speaker attribution model,
 * retries, master TTS gating, and Multi-Voice whole-message playback link).
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildTtsNpcAttributionSummary(state = {}) {
    const translate = typeof state.translate === 'function' ? state.translate : defaultTranslate;
    const npcAttributionEnabled = Boolean(state.npcAttributionEnabled);

    if (!npcAttributionEnabled) {
        return {
            tone: 'dormant',
            rows: [{
                role: translate('Attribution'),
                tone: 'off',
                template: translate('${npcAttributionEnabled} is off — quoted lines play with the message character voice without AI speaker attribution.'),
                tokens: {
                    npcAttributionEnabled: {
                        field: 'npcAttributionEnabled',
                        text: translate('NPC dialogue attribution'),
                        tone: 'off',
                    },
                },
            }],
            warnings: [],
            dormantFields: [...NPC_ATTRIBUTION_SUBFIELDS],
        };
    }

    const enabled = state.enabled !== undefined ? Boolean(state.enabled) : true;
    const apiPreset = String(state.apiPreset || '').trim();
    const preset = String(state.preset || '').trim();
    const retryMax = clampNonNegInt(state.retryMax, 2);
    const multiVoiceEnabled = Boolean(state.multiVoiceEnabled);

    const onMultiVoiceActivate = typeof state.onMultiVoiceActivate === 'function'
        ? state.onMultiVoiceActivate
        : null;
    const canActivateMultiVoice = Boolean(state.canActivateMultiVoice || onMultiVoiceActivate);

    const onEnabledActivate = typeof state.onEnabledActivate === 'function'
        ? state.onEnabledActivate
        : null;
    const canActivateEnabled = Boolean(state.canActivateEnabled || onEnabledActivate);

    const apiToken = {
        field: 'apiPreset',
        text: apiPreset || translate('(Current API config)'),
        tone: 'active',
    };
    const presetToken = {
        field: 'preset',
        text: preset || translate('(Current preset)'),
        tone: 'active',
    };
    const retryToken = {
        field: 'retryMax',
        text: String(retryMax),
        tone: 'active',
    };

    const attributionTokens = {
        apiPreset: apiToken,
        preset: presetToken,
        retryMax: retryToken,
    };
    if (!enabled) {
        attributionTokens.enabled = {
            field: canActivateEnabled ? 'enabled' : null,
            text: translate('Enabled', 'tts_enabled'),
            tone: 'off',
            ...(onEnabledActivate ? { onActivate: onEnabledActivate } : {}),
        };
    }

    const attributionRow = enabled
        ? {
            role: translate('Attribution'),
            template: translate('Attributes quoted dialogue to speakers via ${apiPreset} + ${preset} (up to ${retryMax} retries).'),
            tokens: attributionTokens,
        }
        : {
            role: translate('Attribution'),
            tone: 'off',
            template: translate('Configured with ${apiPreset} + ${preset} (up to ${retryMax} retries), paused while ${enabled} is off.'),
            tokens: attributionTokens,
        };

    const multiVoiceToken = {
        field: canActivateMultiVoice ? 'multiVoiceEnabled' : null,
        text: translate('Different voices for "quotes", *text inside asterisks* and other text', 'Different voices for quotes and text inside asterisks'),
        tone: multiVoiceEnabled ? 'active' : 'warn',
        ...(onMultiVoiceActivate ? { onActivate: onMultiVoiceActivate } : {}),
    };

    const playbackRow = multiVoiceEnabled
        ? {
            role: translate('Playback'),
            template: translate('${multiVoiceEnabled} is active — speaker voices switch during auto/full-message narration and desktop per-quote play buttons.'),
            tokens: { multiVoiceEnabled: multiVoiceToken },
        }
        : {
            role: translate('Playback'),
            tone: 'warn',
            template: translate('${multiVoiceEnabled} is off — auto/full-message narration uses a single speaker voice, so attributed speaker voices only play via desktop per-quote play buttons.'),
            tokens: { multiVoiceEnabled: multiVoiceToken },
        };

    const warnings = [];
    if (!multiVoiceEnabled) {
        warnings.push({
            severity: 'warn',
            template: translate('During auto or full-message narration, speaker voices only switch when ${multiVoiceEnabled} is enabled — otherwise attribution only works via desktop per-quote play buttons.'),
            tokens: { multiVoiceEnabled: multiVoiceToken },
        });
    }

    let tone = 'active';
    if (warnings.length > 0) {
        tone = 'warn';
    } else if (!enabled) {
        tone = 'dormant';
    }

    return {
        tone,
        rows: [attributionRow, playbackRow],
        warnings,
        dormantFields: [],
    };
}
