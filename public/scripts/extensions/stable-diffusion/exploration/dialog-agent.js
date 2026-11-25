// SPDX-License-Identifier: AGPL-3.0-or-later

import { throwIfAborted } from '../../../lib/abort-utils.js';
import { requireStoredPrompt } from '../../../lib/prompt-values.js';
import {
    appendStandardToolRoundMessages,
    makeRuntimeToolCallId,
    requestToolCallsWithRetry,
} from '../../../lib/iter-tool-calling.js';
import { makeIllustrationId } from '../illustration/presets.js';
import {
    GENERATE_IMAGE_TOOL,
    buildGenerateImageTool,
    validateGenerateImageArgs,
} from '../illustration/tools.js';
import { i18n } from '../lens/i18n.js';
import { defaultLoadVisualPreviewDataUrl, resolveExplorationLlm } from './agent.js';
import { assertSourceImagePath } from './source-policy.js';
import {
    EXPLORATION_TOOL_NAMES,
    buildExplorationToolDefs,
    executeExplorationToolCall,
} from './tools.js';

export const STAGE_CHARACTER_PROFILE_TOOL_NAME = 'stage_character_profile';

export const DIALOG_EXPLORATION_TOOL_INSTRUCTIONS = [
    'Use stage_character_profile to update the editable draft shown beside this conversation.',
    'Pass only the fields you want to add or change; omitted fields remain intact.',
    'Do not attempt to write directly to the formal archive; the user reviews and confirms the draft.',
    'You can search public sources, fetch reference images, or call generate_image to produce candidate portraits and reference sheets, then attach returned image paths with short labels in reference_images via stage_character_profile.',
].join(' ');

export const STAGE_CHARACTER_PROFILE_TOOL = Object.freeze({
    type: 'function',
    function: {
        name: STAGE_CHARACTER_PROFILE_TOOL_NAME,
        description: 'Partially update the editable character profile draft for user review. Pass only changed fields; omitted fields stay untouched.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Canonical character display name.' },
                aliases: { type: 'array', items: { type: 'string' } },
                source_work: { type: 'string', description: 'Source franchise or work title, or empty for original characters.' },
                description: {
                    type: 'string',
                    description: 'Structured plain-text visual description (appearance, attire variants, distinguishing traits, and Danbooru character tag if one exists).',
                },
                reference_images: {
                    type: 'array',
                    description: 'Managed /user/images/... paths or image_ids returned by fetch_reference_image or generate_image, with optional short labels.',
                    items: {
                        type: 'object',
                        properties: {
                            path: {
                                type: 'string',
                                description: 'Managed /user/images/... path or image_id returned by fetch_reference_image or generate_image.',
                            },
                            label: {
                                type: 'string',
                                description: 'Optional short portrait label (e.g. default attire, battle attire, close-up).',
                            },
                        },
                        required: ['path'],
                        additionalProperties: false,
                    },
                },
            },
            additionalProperties: false,
        },
    },
});

export function buildCharacterBuilderToolDefs({
    sourcePolicy = { kind: 'none' },
    loras = [],
    includeWeight = false,
    capabilities = null,
} = {}) {
    const baseTools = buildExplorationToolDefs({ sourcePolicy })
        .filter(tool => tool?.function?.name !== EXPLORATION_TOOL_NAMES.SAVE_CHARACTER_PROFILE);
    const generateTool = buildGenerateImageTool(loras, {
        includeWeight,
        capabilities,
        includeStudioFields: true,
    });
    return [
        ...baseTools,
        generateTool,
        JSON.parse(JSON.stringify(STAGE_CHARACTER_PROFILE_TOOL)),
    ];
}

function buildSystemContextBlock({ existingIndex, sourcePolicy, draftProfile }) {
    const sections = [
        `<existing_character_profiles>\n${existingIndex || '(empty)'}\n</existing_character_profiles>`,
        sourcePolicy.kind === 'card'
            ? `Selected source card: ${sourcePolicy.card.avatar}`
            : sourcePolicy.kind === 'persona'
                ? 'Selected source: user persona.'
                : 'Local source: none.',
        `<current_draft_profile>\n${JSON.stringify(draftProfile, null, 2)}\n</current_draft_profile>`,
    ];
    return sections.join('\n\n');
}

function sanitizeHistoryMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map(msg => JSON.parse(JSON.stringify(msg)));
}

function resolveBuilderImageToken(token, generatedById, sourcePolicy, toolName) {
    const raw = String(token || '').trim();
    if (!raw) return '';
    if (generatedById.has(raw)) {
        return generatedById.get(raw);
    }
    assertSourceImagePath(sourcePolicy, raw, toolName);
    return raw;
}

async function readCapabilitiesForDialog(context, media) {
    if (typeof media?.getCapabilities === 'function') {
        const caps = await media.getCapabilities();
        const availableLoras = caps?.availableLoras || { names: [], includeWeight: false };
        return { capabilities: caps, availableLoras };
    }
    if (typeof context?.imageGeneration?.getCapabilities === 'function') {
        const caps = await context.imageGeneration.getCapabilities();
        const availableLoras = caps?.availableLoras || { names: [], includeWeight: false };
        return { capabilities: caps, availableLoras };
    }
    return {
        capabilities: null,
        availableLoras: { names: [], includeWeight: false },
    };
}

export async function runCharacterBuilderTurn({
    context,
    preset = {},
    messages = [],
    draft,
    sourcePolicy = { kind: 'none' },
    profileStore,
    media,
    promptContext = null,
    transientSessionId = undefined,
    onTrace = null,
    onDraftChange = null,
    loadVisualPreviewDataUrl = defaultLoadVisualPreviewDataUrl,
    abortSignal = null,
} = {}) {
    throwIfAborted(abortSignal, 'Character builder turn aborted.');

    const storedPrompt = requireStoredPrompt(
        preset?.explorationPrompt,
        i18n('Fill in the prompt or reset it to the default.'),
    );

    const turnSnapshot = draft.beginTurn();
    const { capabilities, availableLoras } = await readCapabilitiesForDialog(context, media);
    const tools = buildCharacterBuilderToolDefs({
        sourcePolicy,
        loras: availableLoras.names,
        includeWeight: availableLoras.includeWeight,
        capabilities,
    });
    const allowedNames = tools.map(t => t.function.name);
    const { apiPresetName, llmPresetName } = resolveExplorationLlm(preset);
    const visualInspection = Boolean(preset?.visualInspection);
    const resolvedSessionId = transientSessionId !== undefined
        ? transientSessionId
        : media?.sessionId;
    const previewLoader = typeof media?.preview === 'function'
        ? imagePath => media.preview(imagePath)
        : imagePath => loadVisualPreviewDataUrl(imagePath, context);

    const existingProfiles = await profileStore.listProfiles();
    const existingIndex = profileStore.buildCompactProfileIndex(existingProfiles);

    const systemPrompt = [
        storedPrompt,
        DIALOG_EXPLORATION_TOOL_INSTRUCTIONS,
        buildSystemContextBlock({
            existingIndex,
            sourcePolicy,
            draftProfile: turnSnapshot.profile,
        }),
    ].join('\n\n');

    const incomingHistory = sanitizeHistoryMessages(messages);
    const taskMessages = [
        { role: 'system', content: systemPrompt },
        ...incomingHistory,
    ];
    const nextHistory = [...incomingHistory];

    const trace = {
        rounds: [],
        preparedRequests: [],
        generatedImages: [],
        fetchedImages: [],
        draftChanges: [],
        draftConflicts: [],
        visualPreviews: [],
    };

    const generatedById = new Map();
    let finalText = '';
    let roundIndex = 0;

    while (true) {
        throwIfAborted(abortSignal, 'Character builder turn aborted.');
        roundIndex += 1;
        onTrace?.({ type: 'round_start', roundIndex });

        const roundRecord = {
            roundIndex,
            assistantText: '',
            reasoning: '',
            toolCalls: [],
            toolResults: [],
            visualPreviews: [],
        };

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
                    ...(resolvedSessionId !== undefined ? { transientSessionId: resolvedSessionId } : {}),
                    onPreparedRequest: record => {
                        trace.preparedRequests.push({ roundIndex, record });
                        onTrace?.({ type: 'prepared_request', roundIndex, record });
                    },
                },
            );
        } catch (error) {
            onTrace?.({
                type: 'round_end',
                roundIndex,
                status: abortSignal?.aborted ? 'aborted' : 'failed',
                error: String(error?.message || error),
            });
            throw error;
        }

        const calls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
        const assistantText = String(response?.assistantText || '');
        const reasoning = String(response?.reasoning || '');

        roundRecord.assistantText = assistantText;
        roundRecord.reasoning = reasoning;
        roundRecord.toolCalls = calls.map(c => ({ id: c.id || '', name: c.name, args: c.args ?? {} }));

        onTrace?.({
            type: 'model_response',
            roundIndex,
            assistantText,
            reasoning,
            signature: response?.signature || null,
            reasoningBlocks: response?.reasoningBlocks || null,
            reasoningDetails: response?.reasoningDetails || null,
            nativeParts: response?.nativeParts || null,
            nativeContentBlocks: response?.nativeContentBlocks || null,
            responsesOutputItems: response?.responsesOutputItems || null,
            toolCalls: calls,
        });

        if (calls.length === 0) {
            finalText = assistantText;
            nextHistory.push({
                role: 'assistant',
                content: finalText,
                ...(reasoning ? { reasoning } : {}),
                ...(response?.signature ? { signature: response.signature } : {}),
                ...(Array.isArray(response?.reasoningBlocks) && response.reasoningBlocks.length > 0 ? { reasoning_blocks: response.reasoningBlocks } : {}),
                ...(Array.isArray(response?.reasoningDetails) && response.reasoningDetails.length > 0 ? { reasoning_details: response.reasoningDetails } : {}),
                ...(Array.isArray(response?.nativeParts) && response.nativeParts.length > 0 ? { native_parts: response.nativeParts } : {}),
                ...(Array.isArray(response?.nativeContentBlocks) && response.nativeContentBlocks.length > 0 ? { native_content_blocks: response.nativeContentBlocks } : {}),
                ...(Array.isArray(response?.responsesOutputItems) && response.responsesOutputItems.length > 0 ? { responses_output_items: response.responsesOutputItems } : {}),
            });
            trace.rounds.push(roundRecord);
            onTrace?.({ type: 'round_end', roundIndex, status: 'done' });
            break;
        }

        const executedCalls = [];
        const imagesForPreview = [];

        for (const rawCall of calls) {
            throwIfAborted(abortSignal, 'Character builder turn aborted.');
            const callId = String(rawCall?.id || '').trim() || makeRuntimeToolCallId();
            const callName = String(rawCall?.name || '').trim();
            const callArgs = rawCall?.args && typeof rawCall.args === 'object' ? rawCall.args : {};

            let toolResult;
            let isError = false;
            try {
                if (callName === EXPLORATION_TOOL_NAMES.SAVE_CHARACTER_PROFILE) {
                    throw new Error(`${callName}: not_allowed — use stage_character_profile to update the draft`);
                } else if (callName === GENERATE_IMAGE_TOOL.function.name) {
                    if (typeof media?.generate !== 'function') {
                        throw new Error('generate_image: unavailable — image generation media port is missing');
                    }
                    const validation = validateGenerateImageArgs(callArgs, {
                        availableLoras: availableLoras.names,
                        includeWeight: availableLoras.includeWeight,
                        capabilities,
                    });
                    if (!validation.ok) {
                        throw new Error(`generate_image: invalid_args — ${validation.error}`);
                    }
                    const val = validation.value;
                    const references = [];
                    if (val.sourceImageId) {
                        const resolvedSource = resolveBuilderImageToken(val.sourceImageId, generatedById, sourcePolicy, 'generate_image');
                        references.push({ imagePath: resolvedSource, role: 'source' });
                    }
                    for (const token of val.characterImageIds || []) {
                        const resolvedRef = resolveBuilderImageToken(token, generatedById, sourcePolicy, 'generate_image');
                        references.push({ imagePath: resolvedRef, role: 'character' });
                    }
                    const genOpts = {
                        loras: val.loras,
                        signal: abortSignal,
                    };
                    if (val.negativePrompt) genOpts.negativePrompt = val.negativePrompt;
                    if (val.aspectRatio) genOpts.aspectRatio = val.aspectRatio;
                    if (references.length > 0) genOpts.references = references;

                    const imageId = makeIllustrationId('img');
                    const imagePath = await media.generate(val.prompt, genOpts);
                    generatedById.set(imageId, imagePath);
                    const record = {
                        id: imageId,
                        imagePath,
                        prompt: val.prompt,
                        negativePrompt: val.negativePrompt || '',
                        aspectRatio: val.aspectRatio || '',
                        loras: val.loras,
                    };
                    trace.generatedImages.push(record);
                    onTrace?.({ type: 'generated_image', roundIndex, ...record });
                    if (visualInspection && imagePath) {
                        imagesForPreview.push(imagePath);
                    }
                    toolResult = {
                        ok: true,
                        status: 'ready',
                        image_id: imageId,
                        imagePath,
                        prompt: val.prompt,
                    };
                } else if (callName === STAGE_CHARACTER_PROFILE_TOOL_NAME) {
                    const patch = {};
                    for (const key of [
                        'name',
                        'aliases',
                        'source_work',
                        'description',
                    ]) {
                        if (Object.hasOwn(callArgs, key)) {
                            patch[key] = callArgs[key];
                        }
                    }
                    const hasRefImages = Object.hasOwn(callArgs, 'referenceImages') || Object.hasOwn(callArgs, 'reference_images');
                    if (hasRefImages) {
                        const rawRefs = Object.hasOwn(callArgs, 'referenceImages')
                            ? callArgs.referenceImages
                            : callArgs.reference_images;
                        if (!Array.isArray(rawRefs)) {
                            throw new Error('stage_character_profile: invalid_args — reference_images must be an array');
                        }
                        patch.referenceImages = rawRefs.map(entry => {
                            if (typeof entry === 'string') {
                                const str = entry.trim();
                                const resolved = generatedById.get(str) || str;
                                assertSourceImagePath({ kind: 'none' }, resolved, STAGE_CHARACTER_PROFILE_TOOL_NAME);
                                return { path: resolved, label: '' };
                            }
                            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                                throw new Error('stage_character_profile: invalid_args — each reference_images entry must be an object with path');
                            }
                            const str = String(entry.path ?? '').trim();
                            const resolved = generatedById.get(str) || str;
                            assertSourceImagePath({ kind: 'none' }, resolved, STAGE_CHARACTER_PROFILE_TOOL_NAME);
                            return {
                                path: resolved,
                                label: String(entry.label ?? '').trim(),
                            };
                        });
                    }
                    const patchResult = draft.applyAgentPatch(patch, turnSnapshot);
                    const snapshot = draft.getSnapshot();
                    const allConflicts = draft.getConflicts();
                    trace.draftChanges.push(...patchResult.changes);
                    trace.draftConflicts.push(...patchResult.conflicts);
                    onDraftChange?.({
                        patchResult,
                        snapshot,
                        conflicts: allConflicts,
                    });
                    onTrace?.({
                        type: 'draft_staged',
                        roundIndex,
                        patch,
                        changes: patchResult.changes,
                        conflicts: patchResult.conflicts,
                        snapshot,
                    });
                    toolResult = {
                        ok: true,
                        changes: patchResult.changes.map(item => item.path),
                        conflicts: patchResult.conflicts.map(item => ({ id: item.id, path: item.path })),
                        draft: snapshot,
                    };
                } else {
                    toolResult = await executeExplorationToolCall(
                        { id: callId, name: callName, args: callArgs },
                        { context, profileStore, sourcePolicy, media, abortSignal },
                    );
                    if (callName === EXPLORATION_TOOL_NAMES.FETCH_REFERENCE_IMAGE && toolResult?.ok && toolResult?.imagePath) {
                        trace.fetchedImages.push({
                            imagePath: toolResult.imagePath,
                            sourceUrl: String(callArgs.image_url || ''),
                        });
                        if (visualInspection) {
                            imagesForPreview.push(toolResult.imagePath);
                        }
                    }
                }
            } catch (error) {
                if (abortSignal?.aborted) {
                    onTrace?.({
                        type: 'round_end',
                        roundIndex,
                        status: 'aborted',
                        error: String(error?.message || error),
                    });
                    throw error;
                }
                isError = true;
                toolResult = { ok: false, error: String(error?.message || error) };
            }

            roundRecord.toolResults.push({
                callId,
                name: callName,
                args: callArgs,
                result: toolResult,
                isError,
            });
            onTrace?.({
                type: 'tool_result',
                roundIndex,
                callId,
                name: callName,
                args: callArgs,
                result: toolResult,
                isError,
            });

            executedCalls.push({
                id: callId,
                name: callName,
                args: callArgs,
                result: toolResult,
                raw: rawCall?.raw,
                signature: rawCall?.signature,
                extra_content: rawCall?.extra_content,
            });
        }

        const roundMeta = {
            reasoning,
            signature: response?.signature,
            reasoningBlocks: response?.reasoningBlocks,
            reasoningDetails: response?.reasoningDetails,
            nativeParts: response?.nativeParts,
            nativeContentBlocks: response?.nativeContentBlocks,
            responsesOutputItems: response?.responsesOutputItems,
        };
        appendStandardToolRoundMessages(taskMessages, executedCalls, assistantText, roundMeta);
        appendStandardToolRoundMessages(nextHistory, executedCalls, assistantText, roundMeta);

        if (visualInspection && imagesForPreview.length > 0) {
            const previewParts = [];
            for (const imagePath of imagesForPreview) {
                try {
                    const dataUrl = await previewLoader(imagePath);
                    const previewEntry = { roundIndex, imagePath, dataUrl: dataUrl || '', error: '' };
                    trace.visualPreviews.push(previewEntry);
                    roundRecord.visualPreviews.push(previewEntry);
                    onTrace?.({ type: 'visual_preview', ...previewEntry });
                    if (dataUrl) {
                        previewParts.push({
                            type: 'text',
                            text: `[Visual inspection preview for ${imagePath} — verify appearance and visual clarity before keeping it in stage_character_profile]`,
                        });
                        previewParts.push({
                            type: 'image_url',
                            image_url: { url: dataUrl },
                        });
                    }
                } catch (err) {
                    const errorMessage = String(err?.message || err);
                    const previewEntry = { roundIndex, imagePath, dataUrl: '', error: errorMessage };
                    trace.visualPreviews.push(previewEntry);
                    roundRecord.visualPreviews.push(previewEntry);
                    onTrace?.({ type: 'visual_preview', ...previewEntry });
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

        trace.rounds.push(roundRecord);
        onTrace?.({ type: 'round_end', roundIndex, status: 'done' });
    }

    return {
        messages: nextHistory,
        finalText,
        trace,
    };
}
