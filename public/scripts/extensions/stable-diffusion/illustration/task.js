import { buildAddImagePromptTool, buildIllustrationAgentTools } from './tools.js';
import { stripUnlockedIllustrationMarkup } from './message.js';

function speakerName(message) {
    const name = String(message?.name || '').trim();
    if (name) {
        return name;
    }
    return message?.is_user ? 'User' : 'Assistant';
}

function isUsableContextMessage(message) {
    if (!message || message.is_system) {
        return false;
    }
    return String(message.mes || '').trim().length > 0;
}

export function formatBackendCapabilitiesBlock(capabilities) {
    if (!capabilities || typeof capabilities !== 'object') {
        return '';
    }
    const charRefInfo = capabilities.supportsCharacterReference
        ? (capabilities.maxCharacterReferences !== null && capabilities.maxCharacterReferences !== undefined
            ? `supported (max ${capabilities.maxCharacterReferences} per prompt)`
            : 'supported (unlimited)')
        : 'unsupported';
    const lines = [
        `source: ${capabilities.source || 'unknown'}`,
        `model: ${capabilities.model || 'default'}`,
        `character_refs: ${charRefInfo}`,
        `character_captions: ${capabilities.supportsMultiCharacterPrompts ? 'supported' : 'unsupported'}`,
        `dynamic_aspect_ratio: ${capabilities.supportsDynamicAspectRatio !== false ? 'supported' : 'unsupported'}`,
    ];
    return `<backend_capabilities>\n${lines.join('\n')}\n</backend_capabilities>`;
}

export function buildIllustrationContext({
    chat,
    context,
    messageId,
    contextMessageCount,
    stripMarkup,
    lockedIds,
}) {
    const list = Array.isArray(chat) ? chat : (Array.isArray(context?.chat) ? context.chat : []);
    const currentMessage = list[messageId];
    if (!currentMessage) {
        throw new Error(`Message not found at index ${messageId}`);
    }

    const keepIds = lockedIds instanceof Set ? lockedIds : new Set(lockedIds || []);
    let current;
    if (keepIds.size > 0) {
        current = stripUnlockedIllustrationMarkup(String(currentMessage.mes || ''), keepIds).trim();
    } else if (typeof stripMarkup === 'function') {
        current = stripMarkup(String(currentMessage.mes || '')).trim();
    } else {
        current = String(currentMessage.mes || '').trim();
    }

    const count = Math.max(0, Number(contextMessageCount) || 0);
    let history = [];

    if (count > 0) {
        if (typeof context?.readPluginFloors === 'function' && messageId > 0) {
            const floorRecords = context.readPluginFloors({
                toSeq: messageId,
                roles: ['user', 'assistant'],
            });
            history = (Array.isArray(floorRecords) ? floorRecords : [])
                .filter(rec => !rec.is_system && String(rec.mesCooked || '').trim().length > 0)
                .slice(-count)
                .map(rec => {
                    const sourceMsg = list[rec.sourceIndex] || { is_user: rec.is_user };
                    return `[${speakerName(sourceMsg)}]: ${String(rec.mesCooked || '').trim()}`;
                });
        } else {
            history = list
                .slice(0, messageId)
                .filter(isUsableContextMessage)
                .slice(-count)
                .map(message => `[${speakerName(message)}]: ${String(message.mes || '').trim()}`);
        }
    }

    return {
        context: history.join('\n'),
        current,
    };
}

export function buildIllustrationTaskMessages({
    preset,
    context,
    current,
    memoryRecall,
    characterArchiveIndex,
    capabilities,
}) {
    const systemPrompt = String(preset?.illustrationPrompt || '').trim();
    if (!systemPrompt) {
        throw new Error('Illustration prompt is empty.');
    }
    if (!String(current || '').trim()) {
        throw new Error('Current message is empty.');
    }

    const sections = [];
    const capsBlock = formatBackendCapabilitiesBlock(capabilities);
    if (capsBlock) {
        sections.push(capsBlock);
    }
    if (characterArchiveIndex !== undefined && characterArchiveIndex !== null) {
        const archiveText = String(characterArchiveIndex).trim() || '(empty)';
        sections.push(`<character_archive>\n${archiveText}\n</character_archive>`);
    }
    const recall = String(memoryRecall || '').trim();
    if (recall) {
        sections.push(`=== MEMORY RECALL ===\n${recall}`);
    }
    const contextText = String(context || '').trim();
    if (contextText) {
        sections.push(`=== CONTEXT ===\n${contextText}`);
    }
    sections.push(`=== CURRENT MESSAGE ===\n${String(current).trim()}`);

    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: sections.join('\n\n') },
    ];
}

export async function requestIllustrationPrompts({
    context,
    preset,
    taskMessages,
    abortSignal,
    availableLoras = [],
    includeWeight = false,
    capabilities = null,
    includeArchiveTools = false,
    allowExploration = true,
    tools = null,
    promptContext = null,
    transientSessionId = undefined,
    onPreparedRequest = null,
}) {
    if (typeof context?.generateTask !== 'function') {
        throw new Error('generateTask is not available.');
    }
    const resolvedTools = Array.isArray(tools) && tools.length > 0
        ? tools
        : (capabilities || includeArchiveTools
            ? buildIllustrationAgentTools({
                loras: availableLoras,
                includeWeight,
                capabilities,
                includeArchiveTools,
                allowExploration,
            })
            : [buildAddImagePromptTool(availableLoras, { includeWeight })]);

    // Only the preset system prompt (index 0, role "system") is a macro template.
    // Chat transcript excerpts, memory recall, archive blocks, assistant turns,
    // and tool results are runtime data and must not be parsed as strict macros.
    const preparedTaskMessages = Array.isArray(taskMessages)
        ? taskMessages.map((msg, idx) => (
            idx === 0 && msg?.role === 'system'
                ? msg
                : (msg && typeof msg === 'object' ? { ...msg, substituteMacros: false } : msg)
        ))
        : taskMessages;

    const result = await context.generateTask({
        taskMessages: preparedTaskMessages,
        includeCharacterCard: true,
        worldInfoSource: 'chat',
        apiPresetName: preset?.llm?.apiPresetName || '',
        llmPresetName: preset?.llm?.llmPresetName || '',
        tools: resolvedTools,
        toolChoice: 'auto',
        functionCallMode: 'auto',
        substituteMacros: true,
        abortSignal,
        ...(promptContext ? { promptContext } : {}),
        ...(transientSessionId !== undefined ? { transientSessionId } : {}),
        ...(typeof onPreparedRequest === 'function' ? { onPreparedRequest } : {}),
    });
    const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
    const mapped = {
        toolCalls: calls.map(call => {
            const item = { name: String(call?.name || ''), args: call?.args || {} };
            if (call?.id) {
                item.id = String(call.id);
            }
            return item;
        }),
        assistantText: String(result?.assistantText || ''),
        finishReason: String(result?.finishReason || ''),
    };
    if (result?.reasoning) mapped.reasoning = String(result.reasoning);
    if (result?.reasoningBlocks) mapped.reasoningBlocks = result.reasoningBlocks;
    if (result?.reasoningDetails) mapped.reasoningDetails = result.reasoningDetails;
    return mapped;
}
