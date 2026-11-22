// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolveExplorationLlm } from '../exploration/agent.js';
import { buildIllustrationContext } from './task.js';
import { stripIllustrationMarkup, stripUnlockedIllustrationMarkup } from './message.js';

export function isAssistantIllustrationMessage(message) {
    return Boolean(message)
        && !message.is_user
        && !message.is_system
        && !message.extra?.isSmallSys
        && String(message.mes || '').trim().length > 0;
}

export function findLastAssistantIllustrationMessage(chat) {
    for (let index = (Array.isArray(chat) ? chat.length : 0) - 1; index >= 0; index -= 1) {
        if (isAssistantIllustrationMessage(chat[index])) {
            return { message: chat[index], index };
        }
    }
    return null;
}

async function readMemoryRecallSnapshot(context, onWarning = null) {
    const api = context?.getExtensionApi?.('memory-graph');
    if (!api || typeof api.getLastRecallProjection !== 'function') {
        return '';
    }
    let projection;
    try {
        projection = await api.getLastRecallProjection(context);
    } catch (error) {
        onWarning?.(error);
        return '';
    }
    if (!projection?.blocks) {
        return '';
    }
    const core = String(projection.blocks.corePacket || '').trim();
    const focus = String(projection.blocks.focusPacket || '').trim();
    return stripIllustrationMarkup([core, focus].filter(Boolean).join('\n\n'));
}

async function readImageBackendState(context, imageService) {
    const provider = imageService || context?.imageGeneration || null;
    let loras = { names: [], includeWeight: false };
    let capabilities = null;

    if (typeof provider?.getAvailableLoras === 'function') {
        const fetched = await provider.getAvailableLoras();
        if (fetched && typeof fetched === 'object') {
            loras = {
                names: Array.isArray(fetched.names) ? [...fetched.names] : [],
                includeWeight: Boolean(fetched.includeWeight),
            };
        }
    }
    if (typeof provider?.getCapabilities === 'function') {
        const fetchedCaps = await provider.getCapabilities();
        capabilities = fetchedCaps ? JSON.parse(JSON.stringify(fetchedCaps)) : null;
    }

    return { loras, capabilities };
}

function hasSelectedChatTarget(context, resolvedChat) {
    if (context?.groupId) {
        return true;
    }
    if (context?.characterId !== undefined && context?.characterId !== null && context?.characterId !== '') {
        return true;
    }
    return Array.isArray(resolvedChat) && resolvedChat.length > 0;
}

function resolveSingleCardAvatar(context, promptScope) {
    if (promptScope !== 'chat') {
        return '';
    }
    if (context?.groupId) {
        return '';
    }
    if (context?.characterId === undefined || context?.characterId === null || context?.characterId === '') {
        return '';
    }
    return String(context?.characters?.[context.characterId]?.avatar || '');
}

/**
 * Capture a fixed snapshot of all inputs needed to execute `runIllustrationAgent`.
 * Shared between formal chat illustration (`capturePromptContext: false`) and
 * isolated simulation runs (`capturePromptContext: true`).
 *
 * @param {object} options
 * @param {object} options.context
 * @param {object} options.preset
 * @param {number|null} [options.messageIndex=null]
 * @param {string} [options.sampleMessage='']
 * @param {number} [options.contextMessageCount=0]
 * @param {object|null} [options.imageService=null]
 * @param {Array<object>|null} [options.chat=null]
 * @param {Set<string>|Array<string>|null} [options.lockedIds=null]
 * @param {boolean} [options.capturePromptContext=true]
 * @param {(error: Error) => void} [options.onMemoryRecallWarning=null]
 */
export async function captureIllustrationInput({
    context,
    preset,
    messageIndex = null,
    sampleMessage = '',
    contextMessageCount = 0,
    imageService = null,
    chat = null,
    lockedIds = null,
    capturePromptContext = true,
    onMemoryRecallWarning = null,
} = {}) {
    const resolvedChat = Array.isArray(chat) ? chat : (Array.isArray(context?.chat) ? context.chat : []);
    const sampleText = typeof sampleMessage === 'string' ? sampleMessage : '';
    const hasSample = sampleText.trim().length > 0;
    const hasExplicitIndex = messageIndex !== null && messageIndex !== undefined;

    let resolvedIndex = null;
    let current = '';
    let snapshotText = '';
    let recentContext = '';
    let characterName = '';
    let promptScope = 'chat';

    if (hasSample && !hasExplicitIndex) {
        snapshotText = stripIllustrationMarkup(sampleText);
        current = snapshotText.trim();
        recentContext = '';
        characterName = '';
        promptScope = hasSelectedChatTarget(context, resolvedChat) ? 'chat' : 'preset';
    } else {
        if (hasExplicitIndex) {
            const idx = Number(messageIndex);
            if (!Number.isInteger(idx) || idx < 0 || idx >= resolvedChat.length || !resolvedChat[idx]) {
                throw new Error(`Message not found at index ${messageIndex}`);
            }
            resolvedIndex = idx;
        } else {
            const found = findLastAssistantIllustrationMessage(resolvedChat);
            if (!found) {
                throw new Error('No assistant message available to illustrate.');
            }
            resolvedIndex = found.index;
        }
        const targetMessage = resolvedChat[resolvedIndex];
        const keepIds = lockedIds instanceof Set ? lockedIds : new Set(lockedIds || []);
        snapshotText = keepIds.size > 0
            ? stripUnlockedIllustrationMarkup(String(targetMessage.mes || ''), keepIds)
            : stripIllustrationMarkup(String(targetMessage.mes || ''));
        const built = buildIllustrationContext({
            chat: resolvedChat,
            context,
            messageId: resolvedIndex,
            contextMessageCount,
            stripMarkup: stripIllustrationMarkup,
            lockedIds: keepIds,
        });
        current = built.current;
        recentContext = built.context;
        characterName = String(targetMessage.name || '');
        promptScope = 'chat';
    }

    const memoryRecall = promptScope === 'chat'
        ? await readMemoryRecallSnapshot(context, onMemoryRecallWarning)
        : '';
    const { loras, capabilities } = await readImageBackendState(context, imageService);
    const cardAvatar = resolveSingleCardAvatar(context, promptScope);

    let promptContext = null;
    let explorationPromptContext = null;
    if (capturePromptContext && typeof context?.captureTaskPromptContext === 'function') {
        promptContext = await context.captureTaskPromptContext({
            scope: promptScope,
            apiPresetName: String(preset?.llm?.apiPresetName || ''),
            llmPresetName: String(preset?.llm?.llmPresetName || ''),
        });
        const expLlm = resolveExplorationLlm(preset);
        explorationPromptContext = await context.captureTaskPromptContext({
            scope: 'preset',
            apiPresetName: expLlm.apiPresetName,
            llmPresetName: expLlm.llmPresetName,
        });
    }

    return {
        scope: promptScope,
        messageIndex: resolvedIndex,
        characterName,
        current,
        snapshotText,
        context: recentContext,
        memoryRecall,
        loras,
        capabilities,
        cardAvatar,
        promptContext,
        explorationPromptContext,
    };
}
