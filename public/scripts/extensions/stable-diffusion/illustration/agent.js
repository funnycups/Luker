// SPDX-License-Identifier: AGPL-3.0-or-later

import {
    appendStandardToolRoundMessages,
    makeRuntimeToolCallId,
} from '../../../lib/iter-tool-calling.js';
import { formatCharacterProfileForAgent } from '../character-archive/store.js';
import { runExplorationAgent } from '../exploration/agent.js';
import {
    buildIllustrationTaskMessages,
    findCharacterImageConflict,
    requestIllustrationPrompts,
    resolveCharacterReferenceMode,
} from './task.js';
import { ILLUSTRATION_AGENT_TOOL_NAMES, selectPromptCalls } from './tools.js';

const MAX_VALIDATION_SELF_HEAL_RETRIES = 2; // cap-ok: bounds consecutive anchor or reference validation retries when model repeats invalid add_image_prompt arguments

function abortError() {
    const error = new Error('Illustration task cancelled.');
    error.name = 'AbortError';
    return error;
}

function formatActionableRejectionError(reason) {
    if (reason === 'anchors not found') {
        return 'Anchor mismatch: insert_after and insert_before must be adjacent verbatim substrings copied directly from === CURRENT MESSAGE ===.';
    }
    return String(reason || 'Invalid add_image_prompt arguments.');
}

/**
 * Shared execution kernel for message illustration. Used by both the formal
 * chat pipeline and isolated workbench simulations.
 *
 * @param {object} options
 * @param {object} options.context
 * @param {object} options.preset
 * @param {object} options.input Snapshot produced by `captureIllustrationInput`
 * @param {object|null} [options.profileStore=null]
 * @param {{ generate: (prompt: string, options: object) => Promise<string>, fetchReferenceImage?: Function, preview?: Function }} options.media
 * @param {(event: object) => void|null} [options.observe=null]
 * @param {AbortSignal|null} [options.abortSignal=null]
 * @param {boolean} [options.allowExploration=true]
 * @param {string|undefined} [options.transientSessionId=undefined]
 * @param {(() => void)|null} [options.checkAlive=null]
 * @returns {Promise<{ acceptedPrompts: Array<object>, results: Array<object>, savedProfiles: Array<object>, trace: object }>}
 */
export async function runIllustrationAgent({
    context,
    preset,
    input,
    profileStore = null,
    media,
    observe = null,
    abortSignal = null,
    allowExploration = true,
    transientSessionId = undefined,
    capturePreparedRequests = undefined,
    checkAlive = null,
} = {}) {
    if (abortSignal?.aborted) {
        throw abortError();
    }
    checkAlive?.();

    const loras = input?.loras && typeof input.loras === 'object'
        ? { names: Array.isArray(input.loras.names) ? input.loras.names : [], includeWeight: Boolean(input.loras.includeWeight) }
        : { names: [], includeWeight: false };
    const capabilities = input?.capabilities ?? null;
    const charImgConflict = findCharacterImageConflict(capabilities);
    if (charImgConflict) {
        const rawConflict = String(charImgConflict.message || '').trim();
        const err = new Error(rawConflict || 'Character reference images are incompatible with the active image backend or workflow.');
        err.code = 'ref_config_conflict';
        throw err;
    }

    const snapshotText = String(input?.snapshotText ?? input?.current ?? '');
    const canUseCharacterArchive = Boolean(
        profileStore
        && (!capabilities
            || capabilities.characterReferenceEnabled === true
            || (capabilities.characterReferenceEnabled !== false
                && Boolean(capabilities.supportsCharacterTextReference || capabilities.supportsCharacterReference))),
    );
    const activeProfileStore = canUseCharacterArchive ? profileStore : null;
    const profileAgentMode = resolveCharacterReferenceMode(capabilities);

    let profileMap = null;
    let characterArchiveIndex;
    if (activeProfileStore) {
        const existingProfiles = await activeProfileStore.listProfiles();
        profileMap = new Map(existingProfiles.map(p => [p.id, p]));
        characterArchiveIndex = activeProfileStore.buildCompactProfileIndex(existingProfiles, {
            includeImages: Boolean(capabilities?.supportsCharacterReference),
        });
    }

    const taskMessages = buildIllustrationTaskMessages({
        preset,
        context: input?.context || '',
        current: input?.current || '',
        memoryRecall: input?.memoryRecall || '',
        ...(activeProfileStore ? { characterArchiveIndex } : {}),
        capabilities,
        allowExploration,
    });

    const acceptedPrompts = [];
    const seenPromptKeys = new Set();
    const savedProfilesById = new Map();
    const trace = {
        rounds: [],
        images: [],
        savedProfiles: [],
        rejectedFinal: [],
        failure: null,
    };
    let validationRetries = 0;
    let roundIndex = 0;

    while (true) {
        if (abortSignal?.aborted) {
            throw abortError();
        }
        checkAlive?.();

        roundIndex += 1;
        const roundPreparedRequests = [];
        const shouldCapturePrepared = capturePreparedRequests !== undefined
            ? Boolean(capturePreparedRequests)
            : Boolean(transientSessionId !== undefined || input?.promptContext);
        const promptResult = await requestIllustrationPrompts({
            context,
            preset,
            taskMessages,
            abortSignal,
            availableLoras: loras.names,
            includeWeight: loras.includeWeight,
            capabilities,
            includeArchiveTools: Boolean(activeProfileStore),
            allowExploration,
            promptContext: input?.promptContext ?? null,
            transientSessionId,
            ...(shouldCapturePrepared
                ? {
                    onPreparedRequest: record => {
                        roundPreparedRequests.push(record);
                        observe?.({ type: 'prepared_request', roundIndex, record });
                    },
                }
                : {}),
        });
        if (abortSignal?.aborted) {
            throw abortError();
        }
        checkAlive?.();

        const { toolCalls, assistantText, finishReason } = promptResult;
        const roundRecord = {
            roundIndex,
            preparedRequests: roundPreparedRequests,
            assistantText,
            reasoning: promptResult.reasoning || '',
            reasoningBlocks: promptResult.reasoningBlocks || null,
            reasoningDetails: promptResult.reasoningDetails || null,
            finishReason,
            toolCalls: [],
        };
        trace.rounds.push(roundRecord);
        observe?.({
            type: 'model_response',
            roundIndex,
            assistantText,
            reasoning: promptResult.reasoning || '',
            finishReason,
            toolCalls,
        });

        if (toolCalls.length === 0) {
            if (acceptedPrompts.length > 0) {
                break;
            }
            trace.failure = {
                toolCalls: [],
                rejected: [],
                assistantText,
                finishReason,
            };
            observe?.({ type: 'no_prompts', ...trace.failure });
            trace.savedProfiles = [...savedProfilesById.values()];
            return {
                acceptedPrompts: [],
                results: [],
                savedProfiles: [...savedProfilesById.values()],
                trace,
            };
        }

        let hasQueryOrExplore = false;
        const roundRejected = [];
        const executedCalls = [];

        for (const rawCall of toolCalls) {
            if (abortSignal?.aborted) {
                throw abortError();
            }
            checkAlive?.();

            const callId = String(rawCall?.id || '').trim() || makeRuntimeToolCallId();
            if (activeProfileStore && rawCall.name === ILLUSTRATION_AGENT_TOOL_NAMES.READ_CHARACTER_PROFILES) {
                hasQueryOrExplore = true;
                const ids = Array.isArray(rawCall.args?.ids) ? rawCall.args.ids : [];
                observe?.({
                    type: 'tool_start',
                    roundIndex,
                    callId,
                    name: rawCall.name,
                    args: rawCall.args ?? {},
                    ids,
                });
                const profiles = await activeProfileStore.getProfilesByIds(ids);
                for (const p of profiles) {
                    profileMap.set(p.id, p);
                }
                const body = profiles.length > 0
                    ? profiles.map(p => formatCharacterProfileForAgent(p, { mode: profileAgentMode })).join('\n\n---\n\n')
                    : `No character profiles found for ids: ${ids.join(', ')}`;
                observe?.({
                    type: 'tool_done',
                    roundIndex,
                    callId,
                    name: rawCall.name,
                    matched: profiles.length,
                    result: body,
                });
                roundRecord.toolCalls.push({
                    id: callId,
                    name: rawCall.name,
                    args: rawCall.args ?? {},
                    result: body,
                    isError: false,
                });
                executedCalls.push({
                    id: callId,
                    name: rawCall.name,
                    args: rawCall.args,
                    result: body,
                });
                continue;
            }

            if (activeProfileStore && allowExploration && rawCall.name === ILLUSTRATION_AGENT_TOOL_NAMES.EXPLORE_CHARACTERS) {
                hasQueryOrExplore = true;
                const targets = Array.isArray(rawCall.args?.targets) ? rawCall.args.targets : [];
                observe?.({
                    type: 'tool_start',
                    roundIndex,
                    callId,
                    name: rawCall.name,
                    args: rawCall.args ?? {},
                    targets,
                });
                const subTrace = [];
                const expResult = await runExplorationAgent({
                    context,
                    profileStore: activeProfileStore,
                    targets,
                    cardAvatar: String(input?.cardAvatar || ''),
                    preset,
                    media: typeof media?.fetchReferenceImage === 'function' ? media : null,
                    promptContext: input?.explorationPromptContext ?? null,
                    transientSessionId,
                    onTrace: event => {
                        subTrace.push(event);
                        observe?.({ type: 'exploration_trace', roundIndex, callId, event });
                    },
                    abortSignal,
                });
                for (const saved of expResult.savedProfiles) {
                    savedProfilesById.set(saved.id, saved);
                }
                const refreshed = await activeProfileStore.listProfiles();
                profileMap = new Map(refreshed.map(p => [p.id, p]));
                const savedSummaries = expResult.savedProfiles
                    .map(p => formatCharacterProfileForAgent(p, { mode: profileAgentMode }))
                    .join('\n\n---\n\n');
                const body = savedSummaries
                    ? `Saved character profiles:\n\n${savedSummaries}`
                    : (expResult.finalText || 'Exploration finished with no new character profiles saved.');
                observe?.({
                    type: 'tool_done',
                    roundIndex,
                    callId,
                    name: rawCall.name,
                    savedIds: expResult.savedProfiles.map(p => p.id),
                    result: body,
                });
                roundRecord.toolCalls.push({
                    id: callId,
                    name: rawCall.name,
                    args: rawCall.args ?? {},
                    result: body,
                    isError: false,
                    subTrace,
                });
                executedCalls.push({
                    id: callId,
                    name: rawCall.name,
                    args: rawCall.args,
                    result: body,
                });
                continue;
            }

            if (rawCall.name === ILLUSTRATION_AGENT_TOOL_NAMES.ADD_IMAGE_PROMPT) {
                const selection = selectPromptCalls([rawCall], {
                    messageText: snapshotText,
                    availableLoras: loras.names,
                    includeWeight: loras.includeWeight,
                    capabilities,
                    profileMap: profileMap || new Map(),
                });
                if (selection.accepted.length > 0) {
                    const accepted = selection.accepted[0];
                    const dedupeKey = JSON.stringify([
                        accepted.prompt,
                        accepted.insertAfter,
                        accepted.insertBefore,
                        accepted.loras,
                        accepted.aspectRatio || '',
                        accepted.references || [],
                    ]);
                    if (!seenPromptKeys.has(dedupeKey)) {
                        seenPromptKeys.add(dedupeKey);
                        acceptedPrompts.push(accepted);
                    }
                    const resultObj = {
                        ok: true,
                        queued: true,
                        insert_after: accepted.insertAfter,
                        insert_before: accepted.insertBefore,
                    };
                    roundRecord.toolCalls.push({
                        id: callId,
                        name: rawCall.name,
                        args: rawCall.args ?? {},
                        result: resultObj,
                        isError: false,
                    });
                    executedCalls.push({
                        id: callId,
                        name: rawCall.name,
                        args: rawCall.args,
                        result: resultObj,
                    });
                } else if (selection.rejected.length > 0) {
                    const rej = selection.rejected[0];
                    roundRejected.push(rej);
                    const resultObj = {
                        ok: false,
                        error: formatActionableRejectionError(rej.reason),
                    };
                    roundRecord.toolCalls.push({
                        id: callId,
                        name: rawCall.name,
                        args: rawCall.args ?? {},
                        result: resultObj,
                        isError: true,
                    });
                    executedCalls.push({
                        id: callId,
                        name: rawCall.name,
                        args: rawCall.args,
                        result: resultObj,
                    });
                }
                continue;
            }

            roundRejected.push({ reason: 'unknown tool', call: rawCall });
            const unknownResult = { ok: false, error: `Unsupported tool "${rawCall.name}".` };
            roundRecord.toolCalls.push({
                id: callId,
                name: rawCall.name,
                args: rawCall.args ?? {},
                result: unknownResult,
                isError: true,
            });
            executedCalls.push({
                id: callId,
                name: rawCall.name,
                args: rawCall.args,
                result: unknownResult,
            });
        }

        if (!hasQueryOrExplore && roundRejected.length === 0 && acceptedPrompts.length > 0) {
            break;
        }

        if (hasQueryOrExplore) {
            validationRetries = 0;
            appendStandardToolRoundMessages(taskMessages, executedCalls, assistantText, {
                reasoning: promptResult.reasoning,
                reasoningBlocks: promptResult.reasoningBlocks,
                reasoningDetails: promptResult.reasoningDetails,
            });
            continue;
        }

        if (activeProfileStore && roundRejected.length > 0 && validationRetries < MAX_VALIDATION_SELF_HEAL_RETRIES) {
            validationRetries += 1;
            appendStandardToolRoundMessages(taskMessages, executedCalls, assistantText, {
                reasoning: promptResult.reasoning,
                reasoningBlocks: promptResult.reasoningBlocks,
                reasoningDetails: promptResult.reasoningDetails,
            });
            continue;
        }

        if (acceptedPrompts.length > 0) {
            if (roundRejected.length > 0) {
                trace.rejectedFinal = roundRejected;
                observe?.({ type: 'skipped_prompts', rejected: roundRejected });
            }
            break;
        }

        trace.failure = {
            toolCalls,
            rejected: roundRejected,
            assistantText,
            finishReason,
        };
        observe?.({ type: 'no_prompts', ...trace.failure });
        trace.savedProfiles = [...savedProfilesById.values()];
        return {
            acceptedPrompts: [],
            results: [],
            savedProfiles: [...savedProfilesById.values()],
            trace,
        };
    }

    if (abortSignal?.aborted) {
        throw abortError();
    }
    checkAlive?.();
    observe?.({ type: 'prompts_accepted', acceptedPrompts });

    if (typeof media?.generate !== 'function') {
        throw new Error('Illustration media.generate port is required.');
    }

    const characterName = String(input?.characterName || '');
    const settled = await Promise.allSettled(acceptedPrompts.map(async (value, index) => {
        const genOptions = {
            characterName,
            signal: abortSignal,
            loras: value.loras,
        };
        if (value.negativePrompt) genOptions.negativePrompt = value.negativePrompt;
        if (value.aspectRatio) genOptions.aspectRatio = value.aspectRatio;
        if (Array.isArray(value.references) && value.references.length > 0) genOptions.references = value.references;
        if (Array.isArray(value.characterPrompts) && value.characterPrompts.length > 0) genOptions.characterPrompts = value.characterPrompts;
        try {
            const imageUrl = await media.generate(value.prompt, genOptions);
            observe?.({ type: 'image_done', index, prompt: value, imageUrl });
            return { value, imageUrl };
        } catch (error) {
            const aborted = error?.name === 'AbortError' || abortSignal?.aborted;
            if (aborted) {
                observe?.({ type: 'image_aborted', index, prompt: value });
            } else {
                const errorText = String(error?.message || error);
                observe?.({ type: 'image_failed', index, prompt: value, error: errorText });
            }
            throw error;
        }
    }));

    if (abortSignal?.aborted) {
        throw abortError();
    }
    checkAlive?.();

    const results = settled.map((outcome, index) => {
        const value = acceptedPrompts[index];
        if (outcome.status === 'fulfilled') {
            const item = {
                index,
                status: 'ready',
                prompt: value,
                imageUrl: outcome.value.imageUrl,
            };
            trace.images.push(item);
            return item;
        }
        if (outcome.reason?.name === 'AbortError') {
            throw abortError();
        }
        const errorText = String(outcome.reason?.message || outcome.reason);
        const item = {
            index,
            status: 'failed',
            prompt: value,
            error: errorText,
        };
        trace.images.push(item);
        return item;
    });

    trace.savedProfiles = [...savedProfilesById.values()];
    return {
        acceptedPrompts,
        results,
        savedProfiles: [...savedProfilesById.values()],
        trace,
    };
}
