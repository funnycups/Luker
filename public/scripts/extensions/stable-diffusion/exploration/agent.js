// SPDX-License-Identifier: AGPL-3.0-or-later

import { throwIfAborted } from '../../../lib/abort-utils.js';
import { requireStoredPrompt } from '../../../lib/prompt-values.js';
import {
    appendStandardToolRoundMessages,
    makeRuntimeToolCallId,
    requestToolCallsWithRetry,
} from '../../../lib/iter-tool-calling.js';
import { BACKGROUND_EXPLORATION_TOOL_INSTRUCTIONS } from './prompts.js';
import { i18n } from '../lens/i18n.js';
import { createSourcePolicy } from './source-policy.js';
import {
    EXPLORATION_TOOL_NAMES,
    buildExplorationToolDefs,
    executeExplorationToolCall,
} from './tools.js';

const VISUAL_PREVIEW_MAX_EDGE_PX = 512; // cap-ok: downscales local reference preview sent to multimodal LLM inspection to keep vision token cost low

/**
 * Resolves paired `{ apiPresetName, llmPresetName }` for the exploration agent.
 * Inherits `preset.llm` as a pair ONLY when `preset.explorationLlm` sets neither field,
 * preventing cross-provider completion preset mismatches (such as assistant prefill 400s).
 */
export function resolveExplorationLlm(preset = {}) {
    const expApi = String(preset?.explorationLlm?.apiPresetName || '').trim();
    const expLlm = String(preset?.explorationLlm?.llmPresetName || '').trim();
    if (expApi || expLlm) {
        return {
            apiPresetName: expApi,
            llmPresetName: expLlm,
        };
    }
    return {
        apiPresetName: String(preset?.llm?.apiPresetName || '').trim(),
        llmPresetName: String(preset?.llm?.llmPresetName || '').trim(),
    };
}

export async function defaultLoadVisualPreviewDataUrl(imagePath, context) {
    const res = await fetch(imagePath, {
        method: 'GET',
        headers: context?.getRequestHeaders?.() || {},
    });
    if (!res.ok) {
        throw new Error(`Failed to load preview image ${imagePath} (${res.status}).`);
    }
    const blob = await res.blob();

    if (typeof document !== 'undefined' && typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(blob);
        try {
            const scale = Math.min(1, VISUAL_PREVIEW_MAX_EDGE_PX / Math.max(bitmap.width || 1, bitmap.height || 1));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const ctx2d = canvas.getContext('2d');
            ctx2d.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/jpeg', 0.82);
        } finally {
            bitmap.close?.();
        }
    }

    const arrayBuf = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const base64 = typeof btoa === 'function'
        ? btoa(binary)
        : globalThis.Buffer.from(arrayBuf).toString('base64');
    const mime = blob.type || 'image/png';
    return `data:${mime};base64,${base64}`;
}

function buildInitialUserGoal({ targets = [], sourcePolicy, userHint = '', existingIndex = '' }) {
    const sections = [];
    if (existingIndex) {
        sections.push(`<existing_character_profiles>\n${existingIndex}\n</existing_character_profiles>`);
    } else {
        sections.push('<existing_character_profiles>\n(empty)\n</existing_character_profiles>');
    }

    if (Array.isArray(targets) && targets.length > 0) {
        const lines = targets.map((t, idx) => {
            if (typeof t === 'string') return `${idx + 1}. ${t}`;
            const parts = [`${idx + 1}. ${t.name}`];
            if (t?.work) parts.push(`work: ${t.work}`);
            if (t?.hint) parts.push(`context: ${t.hint}`);
            return parts.join(' — ');
        });
        sections.push(`<exploration_targets>\n${lines.join('\n')}\n</exploration_targets>`);
    }

    sections.push(sourcePolicy.kind === 'card'
        ? `Selected source card: ${sourcePolicy.card.avatar}`
        : sourcePolicy.kind === 'persona' ? 'Selected source: user persona.' : 'Local source: none.');
    if (userHint) {
        sections.push(`Additional instructions: ${String(userHint).trim()}`);
    }
    return sections.join('\n\n');
}

export async function runExplorationAgent({
    context,
    profileStore,
    targets = [],
    cardAvatar = '',
    source = null,
    sourcePolicy: providedSourcePolicy = null,
    userHint = '',
    preset = {},
    media = null,
    promptContext = null,
    transientSessionId = undefined,
    onTrace = null,
    runStore = null,
    runId = '',
    abortSignal = null,
    loadVisualPreviewDataUrl = defaultLoadVisualPreviewDataUrl,
} = {}) {
    throwIfAborted(abortSignal, 'Character exploration aborted.');

    const storedPrompt = requireStoredPrompt(preset?.explorationPrompt, i18n('Fill in the prompt or reset it to the default.'));
    if (!Array.isArray(targets) || targets.some(target => (
        typeof target === 'string'
            ? !target.trim()
            : typeof target?.name !== 'string' || !target.name.trim()
    ))) {
        throw new Error('explore_characters: invalid_args — targets must contain character names');
    }
    const sourcePolicy = providedSourcePolicy ?? await createSourcePolicy(
        context,
        source ?? (cardAvatar ? { kind: 'card', card_avatar: cardAvatar } : { kind: 'none' }),
    );
    if (sourcePolicy.kind === 'none' && !targets.length && !String(userHint).trim()) {
        throw new Error(i18n('Enter a character name or choose a source.'));
    }
    const tools = buildExplorationToolDefs({ sourcePolicy });
    const allowedNames = tools.map(t => t.function.name);
    const systemPrompt = `${storedPrompt}\n\n${BACKGROUND_EXPLORATION_TOOL_INSTRUCTIONS}`;
    const { apiPresetName, llmPresetName } = resolveExplorationLlm(preset);
    const visualInspection = Boolean(preset?.visualInspection);
    const previewLoader = typeof media?.preview === 'function'
        ? (imagePath) => media.preview(imagePath)
        : (imagePath) => loadVisualPreviewDataUrl(imagePath, context);

    const existingProfiles = await profileStore.listProfiles();
    const existingIndex = profileStore.buildCompactProfileIndex(existingProfiles);

    const taskMessages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: buildInitialUserGoal({ targets, sourcePolicy, userHint, existingIndex }),
        },
    ];

    const savedById = new Map();
    let finalText = '';
    let roundIndex = 0;

    while (true) {
        throwIfAborted(abortSignal, 'Character exploration aborted.');
        roundIndex += 1;
        const roundId = `exp_round_${roundIndex}`;
        onTrace?.({ type: 'round_start', roundIndex });
        if (runStore && runId) {
            runStore.appendRound?.({
                runId,
                round: { id: roundId, label: `Exploration #${roundIndex}` },
            });
        }

        let response;
        try {
            response = await requestToolCallsWithRetry(
                context,
                { toolCallRetryMax: 2 },
                {
                    taskMessages,
                    apiPresetName,
                    llmPresetName,
                    tools,
                    allowedNames,
                    includeCharacterCard: false,
                    includeAssistantText: true,
                    allowNoToolCalls: true,
                    abortSignal,
                    ...(promptContext ? { promptContext } : {}),
                    ...(transientSessionId !== undefined ? { transientSessionId } : {}),
                    ...(typeof onTrace === 'function'
                        ? { onPreparedRequest: record => onTrace({ type: 'prepared_request', roundIndex, record }) }
                        : {}),
                },
            );
        } catch (err) {
            onTrace?.({
                type: 'round_end',
                roundIndex,
                status: abortSignal?.aborted ? 'aborted' : 'failed',
                error: String(err?.message || err),
            });
            if (runStore && runId) {
                runStore.setRoundStatus?.({
                    runId,
                    roundId,
                    status: abortSignal?.aborted ? 'aborted' : 'failed',
                });
            }
            throw err;
        }

        const calls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
        const assistantText = String(response?.assistantText || '');
        const reasoning = String(response?.reasoning || '');

        onTrace?.({
            type: 'model_response',
            roundIndex,
            assistantText,
            reasoning,
            reasoningBlocks: response?.reasoningBlocks || null,
            reasoningDetails: response?.reasoningDetails || null,
            toolCalls: calls,
        });

        if (runStore && runId) {
            if (reasoning) {
                const secId = `${roundId}_reasoning`;
                runStore.ensureSection?.({
                    runId,
                    roundId,
                    section: { id: secId, kind: 'reasoning', title: 'Reasoning' },
                });
                runStore.appendToSection?.({ runId, roundId, sectionId: secId, delta: reasoning });
                runStore.setSectionStatus?.({ runId, roundId, sectionId: secId, status: 'done' });
            }
            if (assistantText) {
                const secId = `${roundId}_text`;
                runStore.ensureSection?.({
                    runId,
                    roundId,
                    section: { id: secId, kind: 'text', title: 'Assistant' },
                });
                runStore.appendToSection?.({ runId, roundId, sectionId: secId, delta: assistantText });
                runStore.setSectionStatus?.({ runId, roundId, sectionId: secId, status: 'done' });
            }
        }

        if (calls.length === 0) {
            finalText = assistantText;
            onTrace?.({ type: 'round_end', roundIndex, status: 'done' });
            if (runStore && runId) {
                runStore.setRoundStatus?.({ runId, roundId, status: 'done' });
            }
            break;
        }

        const executedCalls = [];
        const fetchedForPreview = [];

        for (const rawCall of calls) {
            throwIfAborted(abortSignal, 'Character exploration aborted.');
            const callId = String(rawCall?.id || '').trim() || makeRuntimeToolCallId();
            const toolSecId = `${roundId}_tool_${callId}`;
            const argsText = JSON.stringify(rawCall.args ?? {});
            if (runStore && runId) {
                runStore.ensureSection?.({
                    runId,
                    roundId,
                    section: {
                        id: toolSecId,
                        kind: 'tool',
                        title: `${rawCall.name}`,
                        meta: { callId, name: rawCall.name },
                    },
                });
                runStore.appendToSection?.({
                    runId,
                    roundId,
                    sectionId: toolSecId,
                    delta: `Args: ${argsText}`,
                });
            }

            let toolResult;
            let isError = false;
            try {
                toolResult = await executeExplorationToolCall(
                    { id: callId, name: rawCall.name, args: rawCall.args },
                    { context, profileStore, sourcePolicy, media, abortSignal },
                );
                if (rawCall.name === EXPLORATION_TOOL_NAMES.SAVE_CHARACTER_PROFILE && toolResult?.savedProfile) {
                    savedById.set(toolResult.savedProfile.id, toolResult.savedProfile);
                }
                if (visualInspection && rawCall.name === EXPLORATION_TOOL_NAMES.FETCH_REFERENCE_IMAGE && toolResult?.ok && toolResult?.imagePath) {
                    fetchedForPreview.push(toolResult.imagePath);
                }
            } catch (err) {
                if (abortSignal?.aborted) {
                    onTrace?.({
                        type: 'round_end',
                        roundIndex,
                        status: 'aborted',
                        error: String(err?.message || err),
                    });
                    if (runStore && runId) {
                        runStore.setSectionStatus?.({ runId, roundId, sectionId: toolSecId, status: 'aborted' });
                        runStore.setRoundStatus?.({ runId, roundId, status: 'aborted' });
                    }
                    throw err;
                }
                isError = true;
                toolResult = { ok: false, error: String(err?.message || err) };
            }

            onTrace?.({
                type: 'tool_result',
                roundIndex,
                callId,
                name: rawCall.name,
                args: rawCall.args ?? {},
                result: toolResult,
                isError,
            });

            if (runStore && runId) {
                const resultText = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
                runStore.appendToSection?.({
                    runId,
                    roundId,
                    sectionId: toolSecId,
                    delta: `\nResult: ${resultText}`,
                });
                runStore.setSectionStatus?.({
                    runId,
                    roundId,
                    sectionId: toolSecId,
                    status: isError ? 'failed' : 'done',
                });
            }

            executedCalls.push({
                id: callId,
                name: rawCall.name,
                args: rawCall.args,
                result: toolResult,
            });
        }

        appendStandardToolRoundMessages(taskMessages, executedCalls, assistantText, {
            reasoning,
            reasoningBlocks: response?.reasoningBlocks,
            reasoningDetails: response?.reasoningDetails,
        });

        if (visualInspection && fetchedForPreview.length > 0) {
            const previewParts = [];
            for (const imagePath of fetchedForPreview) {
                try {
                    const dataUrl = await previewLoader(imagePath);
                    onTrace?.({ type: 'visual_preview', roundIndex, imagePath, dataUrl: dataUrl || '', error: '' });
                    if (dataUrl) {
                        previewParts.push({
                            type: 'text',
                            text: `[Visual inspection preview for ${imagePath} — confirm subject accuracy before referencing in save_character_profile]`,
                        });
                        previewParts.push({
                            type: 'image_url',
                            image_url: { url: dataUrl },
                        });
                    }
                } catch (err) {
                    const errorMessage = String(err?.message || err);
                    onTrace?.({ type: 'visual_preview', roundIndex, imagePath, dataUrl: '', error: errorMessage });
                    previewParts.push({
                        type: 'text',
                        text: `[Visual inspection preview unavailable for ${imagePath}: ${errorMessage}]`,
                    });
                }
            }
            if (previewParts.length > 0) {
                taskMessages.push({
                    role: 'user',
                    content: previewParts,
                });
            }
        }

        onTrace?.({ type: 'round_end', roundIndex, status: 'done' });
        if (runStore && runId) {
            runStore.setRoundStatus?.({ runId, roundId, status: 'done' });
        }
    }

    return {
        savedProfiles: [...savedById.values()],
        finalText,
    };
}
