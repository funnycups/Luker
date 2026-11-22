// SPDX-License-Identifier: AGPL-3.0-or-later

import { baseChatReplace, getMaxContextTokens, getMaxPromptTokens, getMaxResponseTokens, main_api, parseMesExamples } from '../script.js';
import { extensionNames, extension_settings } from './extensions.js';
import { power_user } from './power-user.js';
import { MacroEnvBuilder } from './macros/engine/MacroEnvBuilder.js';
import { substituteCapturedMacros } from './macros/snapshot.js';
import { getLastGenerationType } from './macros/definitions/state-macros.js';
import { captureRegexScripts, getRegexedString } from './extensions/regex/engine.js';
import { formatInstructModeExamples } from './instruct-mode.js';
import { getStringHash } from './utils.js';
import { getGroupNames } from './group-chats.js';
import { isMobile as isMobileDevice } from './RossAscends-mods.js';
import { inject_ids } from './constants.js';
import { resolveProfile } from './generate-task.js';
import { collectScriptInjectPromptFields, getContext, getPluginPromptOrderPreferredCharacterIds } from './st-context.js';

const copy = value => JSON.parse(JSON.stringify(value));

function captureKey(context) {
    return JSON.stringify([context.characterId, context.groupId, context.getCurrentChatId()]);
}

function captureMacroEnv(context, includeChat) {
    const environment = MacroEnvBuilder.buildFromRawEnv({
        content: '',
        replaceCharacterCard: false,
        ...(includeChat ? {} : { name1Override: '', name2Override: '', groupOverride: '' }),
    }, { includeProviders: false });
    const metadata = includeChat ? copy(context.chatMetadata) : {};
    const outletPrefix = inject_ids.CUSTOM_WI_OUTLET('');
    const displayedId = includeChat ? document.querySelector('#chat .mes')?.getAttribute('mesid') : null;
    return {
        names: environment.names,
        character: {},
        system: environment.system,
        variables: {
            local: includeChat ? copy(metadata.variables ?? {}) : {},
            global: includeChat ? copy(extension_settings.variables?.global ?? {}) : {},
        },
        powerUser: copy({
            instruct: power_user.instruct,
            context: power_user.context,
            sysprompt: power_user.sysprompt,
            prefer_character_prompt: power_user.prefer_character_prompt,
        }),
        contextSnapshot: {
            chat: includeChat ? copy(context.chat) : [],
            chatMetadata: metadata,
            groupNames: includeChat ? copy(getGroupNames()) : [],
            now: Date.now(),
            firstDisplayedMessageId: displayedId === null ? null : Number(displayedId),
            formattedExamples: '',
            input: includeChat ? String(document.querySelector('#send_textarea')?.value ?? '') : '',
            isMobile: isMobileDevice(),
            lastGenerationType: includeChat ? getLastGenerationType() : '',
            extensions: includeChat
                ? extensionNames.map(name => ({ name, enabled: !extension_settings.disabledExtensions.includes(name) }))
                : [],
            outlets: includeChat
                ? Object.fromEntries(Object.entries(context.extensionPrompts)
                    .filter(([key]) => key.startsWith(outletPrefix))
                    .map(([key, value]) => [key, String(value.value ?? '')]))
                : {},
            chatIdHash: includeChat
                ? (typeof metadata.chat_id_hash === 'number' ? metadata.chat_id_hash : getStringHash(String(metadata.main_chat ?? context.getCurrentChatId() ?? '')))
                : 0,
            maxPromptTokens: getMaxPromptTokens(),
            maxContextTokens: getMaxContextTokens(),
            maxResponseTokens: getMaxResponseTokens(),
        },
    };
}

/**
 * Capture prompt inputs once. The result contains data only, so later task rounds
 * do not consult another selected chat, live macro handlers, or regex providers.
 */
export async function captureTaskPromptContext({ scope, llmPresetName = '', apiPresetName = '' } = {}) {
    if (scope !== 'preset' && scope !== 'chat') throw new TypeError('Task prompt scope must be "preset" or "chat".');
    if (typeof llmPresetName !== 'string' || typeof apiPresetName !== 'string') {
        throw new TypeError('Task connection and completion preset names must be strings.');
    }
    const context = getContext();
    const includeChat = scope === 'chat';
    const key = includeChat ? captureKey(context) : null;
    const profile = resolveProfile(apiPresetName, { defaultApi: main_api });
    const macroEnv = captureMacroEnv(context, includeChat);
    const substitute = (text, options) => substituteCapturedMacros(text, macroEnv, options);
    const fields = includeChat ? context.getCharacterCardFields({
        chid: context.characterId,
        replace: (text, user, character) => baseChatReplace(text, user, character, { substitute }),
    }) : {};
    macroEnv.character = {
        description: fields.description ?? '',
        personality: fields.personality ?? '',
        scenario: fields.scenario ?? '',
        persona: fields.persona ?? '',
        charPrompt: fields.system ?? '',
        charInstruction: fields.jailbreak ?? '',
        mesExamplesRaw: fields.mesExamples ?? '',
        charDepthPrompt: fields.charDepthPrompt ?? '',
        creatorNotes: fields.creatorNotes ?? '',
        version: fields.version ?? '',
        firstMessage: fields.firstMessage ?? '',
        alternateGreetings: fields.alternateGreetings ?? [],
    };
    const isInstruct = Boolean(power_user.instruct.enabled) && profile.requestApi !== 'openai';
    const exampleSubstitute = (text, options) => substitute(text, {
        ...options, dynamicMacros: { name: '{{name}}' },
    });
    const examples = parseMesExamples(fields.mesExamples, isInstruct, {
        substitute: exampleSubstitute, api: profile.requestApi,
    });
    macroEnv.contextSnapshot.formattedExamples = (isInstruct
        ? formatInstructModeExamples(examples, macroEnv.names.user, macroEnv.names.char, { substitute: exampleSubstitute })
        : examples).join('');
    const envelope = context.getActivePromptPresetEnvelope({
        includeCharacterCard: includeChat,
        api: llmPresetName ? 'openai' : profile.requestApi,
        promptPresetName: llmPresetName,
        capturedContext: { fields, character: includeChat ? { name: macroEnv.names.char } : null, macroEnv },
    });
    const manager = context.getPresetManager(envelope.completionApi);
    const preset = {
        apiId: envelope.completionApi,
        name: envelope.presetRefs.completion,
        settings: llmPresetName
            ? manager.getStoredPreset(envelope.presetRefs.completion)
            : manager.getPresetSettings(envelope.presetRefs.completion),
    };
    const regexScripts = captureRegexScripts({ includeCharacter: includeChat, preset });
    const applyRegex = (text, placement, options) => getRegexedString(text, placement, {
        ...options, scripts: regexScripts, substitute, isolated: true,
    });
    const scriptInjectFields = includeChat
        ? collectScriptInjectPromptFields({ substitute })
        : { before: '', after: '', depthEntries: [] };
    const preferredCharacterIds = getPluginPromptOrderPreferredCharacterIds({ includeCharacter: includeChat });
    const runtimeWorldInfo = includeChat ? await context.resolveWorldInfoForMessages(macroEnv.contextSnapshot.chat, {
        fallbackToCurrentChat: false,
        globalScanData: {
            personaDescription: fields.persona ?? '',
            characterDescription: fields.description ?? '',
            characterPersonality: fields.personality ?? '',
            characterDepthPrompt: fields.charDepthPrompt ?? '',
            scenario: fields.scenario ?? '',
            creatorNotes: fields.creatorNotes ?? '',
            trigger: 'quiet',
        },
        maxContext: macroEnv.contextSnapshot.maxPromptTokens,
        dryRun: true,
        isolated: true,
        throwOnError: true,
        substitute,
        applyRegex,
    }) : {};
    if (includeChat && captureKey(context) !== key) {
        throw new Error('The chat changed while capturing its prompt context. Capture it again.');
    }
    for (const [name, entries] of Object.entries(runtimeWorldInfo.outletEntries ?? {})) {
        macroEnv.contextSnapshot.outlets[inject_ids.CUSTOM_WI_OUTLET(name)] = entries.join('\n');
    }
    return copy({ scope, envelope, runtimeWorldInfo, macroEnv, regexScripts, scriptInjectFields, preferredCharacterIds });
}
