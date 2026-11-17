import {
    appendStandardToolRoundMessages,
    makeRuntimeToolCallId,
} from '../../../lib/iter-tool-calling.js';
import { createCharacterProfileStore } from '../character-archive/store.js';
import { runExplorationAgent } from '../exploration/agent.js';
import { buildIllustrationContext, buildIllustrationTaskMessages, requestIllustrationPrompts } from './task.js';
import { ILLUSTRATION_AGENT_TOOL_NAMES, selectPromptCalls } from './tools.js';
import { applyIllustrationResult, collectVersionTree, createIllustrationRecord, syncMessageSwipeData } from './records.js';
import { getPresetById } from './settings.js';
import { makeIllustrationId } from './presets.js';
import { stripIllustrationMarkup, stripUnlockedIllustrationMarkup } from './message.js';

const MAX_VALIDATION_SELF_HEAL_RETRIES = 2; // cap-ok: bounds consecutive anchor or reference validation retries when model repeats invalid add_image_prompt arguments

function hashText(text) {
    let hash = 2166136261;
    const value = String(text ?? '');
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

export function messageFingerprint(message) {
    return [String(message?.send_date ?? ''), String(message?.original_avatar ?? ''), hashText(message?.mes)].join('|');
}

function isAssistantMessage(message) {
    return Boolean(message)
        && !message.is_user
        && !message.is_system
        && !message.extra?.isSmallSys
        && String(message.mes || '').trim().length > 0;
}

export function getLastAssistantMessage(chat) {
    for (let index = (Array.isArray(chat) ? chat.length : 0) - 1; index >= 0; index -= 1) {
        if (isAssistantMessage(chat[index])) {
            return { message: chat[index], index };
        }
    }
    return null;
}

export function buildJobKey({ chatId, messageId, swipeId }) {
    return `${chatId}:${messageId}:${swipeId}`;
}

function abortError() {
    const error = new Error('Illustration task cancelled.');
    error.name = 'AbortError';
    return error;
}

function rejectionLabel(reason, t) {
    switch (String(reason || '')) {
        case 'unknown tool': return t`unsupported tool`;
        case 'anchors not found': return t`quoted text not found`;
        case 'prompt is required': return t`missing prompt`;
        case 'insert_after is required': return t`missing insert_after`;
        case 'insert_before is required': return t`missing insert_before`;
        default: return String(reason || t`unknown error`);
    }
}

function summarizeRejections(rejected, t) {
    const counts = new Map();
    for (const entry of rejected) {
        const label = rejectionLabel(entry?.reason, t);
        counts.set(label, (counts.get(label) || 0) + 1);
    }
    return [...counts.entries()].map(([label, count]) => `${label} ×${count}`).join(', ');
}

function buildPromptFailure({ toolCalls, selection, assistantText, finishReason }, t) {
    let reason;
    if (toolCalls.length === 0) {
        reason = assistantText.trim()
            ? t`The model replied with text but did not call add_image_prompt.`
            : t`The model returned no image prompts.`;
    } else {
        const details = summarizeRejections(selection.rejected, t);
        reason = details
            ? t`No image prompts could be used: ${details}.`
            : t`No image prompts could be used.`;
    }

    const lines = [reason];
    if (finishReason) {
        lines.push(t`Finish reason: ${finishReason}`);
    }
    if (assistantText.trim()) {
        lines.push(`${t`Model response`}:\n${assistantText.trim()}`);
    }
    if (selection.rejected.length > 0) {
        lines.push(t`Rejected calls:`);
        selection.rejected.forEach((entry, index) => {
            const prompt = String(entry?.call?.args?.prompt || '').trim();
            const label = rejectionLabel(entry?.reason, t);
            lines.push(prompt ? `${index + 1}. ${label}\n${prompt}` : `${index + 1}. ${label}`);
        });
    }

    return { reason, report: lines.join('\n\n') };
}

function formatProfileDetailForIllustration(profile) {
    const lines = [
        `id: ${profile.id}`,
        `name: ${profile.name}`,
    ];
    if (profile.aliases?.length) lines.push(`aliases: ${profile.aliases.join(', ')}`);
    if (profile.sourceWork) lines.push(`work: ${profile.sourceWork}`);
    if (profile.canonicalTags?.length) lines.push(`canonical_tags: ${profile.canonicalTags.join(', ')}`);
    if (profile.negativeTags?.length) lines.push(`negative_tags: ${profile.negativeTags.join(', ')}`);
    if (profile.proseDescription) lines.push(`prose_description: ${profile.proseDescription}`);
    if (profile.defaultOutfitId) lines.push(`default_outfit_id: ${profile.defaultOutfitId}`);
    if (Array.isArray(profile.outfits) && profile.outfits.length > 0) {
        lines.push('outfits:');
        for (const outfit of profile.outfits) {
            const parts = [`  - id=${outfit.id} name="${outfit.name}"`];
            if (outfit.tags?.length) parts.push(`tags=[${outfit.tags.join(', ')}]`);
            if (outfit.prose) parts.push(`prose="${outfit.prose}"`);
            parts.push(`reference_images=${outfit.referenceImages?.length || 0}`);
            lines.push(parts.join(' | '));
        }
    }
    return lines.join('\n');
}

function formatActionableRejectionError(reason) {
    if (reason === 'anchors not found') {
        return 'Anchor mismatch: insert_after and insert_before must be adjacent verbatim substrings copied directly from === CURRENT MESSAGE ===.';
    }
    return String(reason || 'Invalid add_image_prompt arguments.');
}

function defaultTranslate(strings, ...values) {
    if (Array.isArray(strings)) {
        return strings.reduce((out, str, index) => out + str + (values[index] ?? ''), '');
    }
    return String(strings ?? '');
}

export function createIllustrationPipeline({ context, imageService, settings, hooks }) {
    const jobs = new Map();
    const handled = new Set();
    const t = hooks.t ?? defaultTranslate;
    const toast = (message, type = 'error') => hooks.toast?.(message, type);
    const notifyError = typeof hooks.notifyError === 'function'
        ? hooks.notifyError
        : message => toast(message, 'error');

    function contextMatches(job) {
        if (hooks.getChatId() !== job.chatId) {
            return false;
        }
        const message = hooks.getChat()?.[job.messageId];
        if (!message) {
            return false;
        }
        if ((message.swipe_id ?? 0) !== job.swipeId) {
            return false;
        }
        return messageFingerprint(message) === job.messageFingerprint;
    }

    function releaseJob(job) {
        if (jobs.get(job.key) === job) {
            jobs.delete(job.key);
        }
    }

    function cancelJob(job) {
        if (!job) {
            return;
        }
        job.state = 'cancelled';
        job.activityJob?.finish('aborted');
        if (!job.abortController.signal.aborted) {
            job.abortController.abort('Cancelled');
        }
        releaseJob(job);
    }

    async function readMemoryRecall() {
        const api = context.getExtensionApi?.('memory-graph');
        if (!api || typeof api.getLastRecallProjection !== 'function') {
            return '';
        }
        let projection;
        try {
            projection = await api.getLastRecallProjection(context);
        } catch (error) {
            toast(`${t`Memory recall is unavailable`}: ${error?.message || error}`, 'warning');
            return '';
        }
        if (!projection?.blocks) {
            return '';
        }
        const core = String(projection.blocks.corePacket || '').trim();
        const focus = String(projection.blocks.focusPacket || '').trim();
        return stripIllustrationMarkup([core, focus].filter(Boolean).join('\n\n'));
    }

    async function runForMessage({ messageId, source = 'auto' }) {
        if (!settings.enabled) {
            return;
        }
        const preset = getPresetById(settings, settings.currentPresetId);
        if (!preset) {
            notifyError(t`No illustration preset is selected.`);
            return;
        }
        if (!String(preset.illustrationPrompt || '').trim()) {
            notifyError(t`The illustration prompt is empty.`);
            return;
        }

        const chatId = hooks.getChatId();
        const chat = hooks.getChat();
        const message = chat?.[messageId];
        if (!isAssistantMessage(message)) {
            return;
        }

        const swipeId = message.swipe_id ?? 0;
        const key = buildJobKey({ chatId, messageId, swipeId });
        const existing = jobs.get(key);
        const hadRecords = Array.isArray(message.extra?.illustrations) && message.extra.illustrations.length > 0;

        if (source === 'auto') {
            if (existing || hadRecords) {
                return;
            }
        }

        if (source === 'manual' && hadRecords) {
            const confirmed = typeof hooks.confirmReplace === 'function'
                ? await hooks.confirmReplace(messageId)
                : true;
            if (!confirmed) {
                return;
            }
            const currentRecords = Array.isArray(message.extra?.illustrations) ? message.extra.illustrations : [];
            const lockedActiveIds = new Set(
                currentRecords
                    .filter(r => r?.locked && String(message.mes || '').includes(`data-illustration-id="${r.id}"`))
                    .map(r => r.id),
            );
            if (lockedActiveIds.size > 0) {
                const keepRecordIds = new Set();
                for (const lockedId of lockedActiveIds) {
                    const rec = currentRecords.find(r => r.id === lockedId);
                    for (const treeMember of collectVersionTree(message, rec)) {
                        keepRecordIds.add(treeMember.id);
                    }
                }
                message.mes = stripUnlockedIllustrationMarkup(message.mes, lockedActiveIds);
                message.extra.illustrations = currentRecords.filter(r => keepRecordIds.has(r.id));
            } else {
                message.mes = stripIllustrationMarkup(message.mes);
                message.extra.illustrations = [];
            }
            syncMessageSwipeData(message, hooks.ensureSwipes);
            hooks.updateMessageBlock?.(messageId, message);
            await hooks.notifyMessageChanged?.(messageId);
            await hooks.saveChat();
        }

        if (existing) {
            cancelJob(existing);
        }

        const job = {
            id: makeIllustrationId('job'),
            key,
            chatId,
            messageId,
            swipeId,
            messageFingerprint: messageFingerprint(message),
            source,
            presetId: preset.id,
            abortController: new AbortController(),
            state: 'prompting',
        };
        jobs.set(key, job);

        try {
            const lockedIds = new Set(
                (Array.isArray(message.extra?.illustrations) ? message.extra.illustrations : [])
                    .filter(r => r?.locked)
                    .map(r => r.id),
            );
            const snapshotText = lockedIds.size > 0
                ? stripUnlockedIllustrationMarkup(String(message.mes || ''), lockedIds)
                : stripIllustrationMarkup(String(message.mes || ''));
            const built = buildIllustrationContext({
                chat,
                context,
                messageId,
                contextMessageCount: settings.contextMessageCount,
                stripMarkup: stripIllustrationMarkup,
                lockedIds,
            });
            const memoryRecall = await readMemoryRecall();
            if (!contextMatches(job)) {
                throw abortError();
            }

            const hasGlobalArchive = typeof context?.getGlobalState === 'function'
                && typeof context?.updateGlobalState === 'function';
            const profileStore = hasGlobalArchive ? createCharacterProfileStore(context) : null;
            let profileMap = null;
            let characterArchiveIndex;
            if (profileStore) {
                const existingProfiles = await profileStore.listProfiles();
                profileMap = new Map(existingProfiles.map(p => [p.id, p]));
                characterArchiveIndex = profileStore.buildCompactProfileIndex(existingProfiles);
            }

            const activityJob = typeof hooks.beginActivityJob === 'function'
                ? hooks.beginActivityJob({
                    kind: 'illustration',
                    messageIndex: messageId,
                    abort: () => cancelJob(job),
                })
                : null;
            job.activityJob = activityJob;

            job.state = 'generating';
            const loraState = await imageService.getAvailableLoras();
            const capabilities = typeof imageService?.getCapabilities === 'function'
                ? await imageService.getCapabilities()
                : null;

            const taskMessages = buildIllustrationTaskMessages({
                preset,
                context: built.context,
                current: built.current,
                memoryRecall,
                ...(profileStore ? { characterArchiveIndex } : {}),
                capabilities,
            });

            const acceptedPrompts = [];
            const seenPromptKeys = new Set();
            let validationRetries = 0;

            while (true) {
                const promptResult = await requestIllustrationPrompts({
                    context,
                    preset,
                    taskMessages,
                    abortSignal: job.abortController.signal,
                    availableLoras: loraState.names,
                    includeWeight: loraState.includeWeight,
                    capabilities,
                    includeArchiveTools: Boolean(profileStore),
                });
                if (!contextMatches(job)) {
                    throw abortError();
                }

                const { toolCalls, assistantText, finishReason } = promptResult;
                if (toolCalls.length === 0) {
                    if (acceptedPrompts.length > 0) {
                        break;
                    }
                    const failure = buildPromptFailure({
                        toolCalls: [],
                        selection: { accepted: [], rejected: [] },
                        assistantText,
                        finishReason,
                    }, t);
                    job.state = 'failed';
                    activityJob?.setError(failure.report);
                    activityJob?.finish('failed');
                    releaseJob(job);
                    console.error('Illustration prompt request produced no usable prompts.', failure.reason);
                    notifyError(`${t`Illustration failed`}: ${failure.reason}`);
                    return;
                }

                let hasQueryOrExplore = false;
                const roundRejected = [];
                const executedCalls = [];

                for (const rawCall of toolCalls) {
                    const callId = String(rawCall?.id || '').trim() || makeRuntimeToolCallId();
                    if (profileStore && rawCall.name === ILLUSTRATION_AGENT_TOOL_NAMES.READ_CHARACTER_PROFILES) {
                        hasQueryOrExplore = true;
                        const ids = Array.isArray(rawCall.args?.ids) ? rawCall.args.ids : [];
                        const secKey = `read-profiles-${callId}`;
                        activityJob?.addSection(secKey, {
                            kind: 'tool',
                            title: `read_character_profiles (${ids.join(', ')})`,
                            body: JSON.stringify(rawCall.args ?? {}),
                        });
                        const profiles = await profileStore.getProfilesByIds(ids);
                        for (const p of profiles) {
                            profileMap.set(p.id, p);
                        }
                        const body = profiles.length > 0
                            ? profiles.map(formatProfileDetailForIllustration).join('\n\n---\n\n')
                            : `No character profiles found for ids: ${ids.join(', ')}`;
                        activityJob?.updateSection(secKey, { status: 'done', meta: { matched: profiles.length } });
                        executedCalls.push({
                            id: callId,
                            name: rawCall.name,
                            args: rawCall.args,
                            result: body,
                        });
                        continue;
                    }

                    if (profileStore && rawCall.name === ILLUSTRATION_AGENT_TOOL_NAMES.EXPLORE_CHARACTERS) {
                        hasQueryOrExplore = true;
                        const targets = Array.isArray(rawCall.args?.targets) ? rawCall.args.targets : [];
                        const targetLabel = targets.map(item => String(item?.name || '').trim()).filter(Boolean).join(', ');
                        const secKey = `explore-characters-${callId}`;
                        activityJob?.addSection(secKey, {
                            kind: 'tool',
                            title: targetLabel ? `explore_characters (${targetLabel})` : 'explore_characters',
                            body: JSON.stringify(rawCall.args ?? {}),
                        });
                        const cardAvatar = (!context?.groupId && context?.characterId !== undefined && context?.characterId !== null)
                            ? String(context?.characters?.[context.characterId]?.avatar || '')
                            : '';
                        const expResult = await runExplorationAgent({
                            context,
                            profileStore,
                            targets,
                            cardAvatar,
                            preset,
                            abortSignal: job.abortController.signal,
                        });
                        activityJob?.updateSection(secKey, {
                            status: 'done',
                            meta: { savedIds: expResult.savedProfiles.map(p => p.id) },
                        });
                        const refreshed = await profileStore.listProfiles();
                        profileMap = new Map(refreshed.map(p => [p.id, p]));
                        const savedSummaries = expResult.savedProfiles.map(formatProfileDetailForIllustration).join('\n\n---\n\n');
                        executedCalls.push({
                            id: callId,
                            name: rawCall.name,
                            args: rawCall.args,
                            result: savedSummaries
                                ? `Saved character profiles:\n\n${savedSummaries}`
                                : (expResult.finalText || 'Exploration finished with no new character profiles saved.'),
                        });
                        continue;
                    }

                    if (rawCall.name === ILLUSTRATION_AGENT_TOOL_NAMES.ADD_IMAGE_PROMPT) {
                        const selection = selectPromptCalls([rawCall], {
                            messageText: snapshotText,
                            availableLoras: loraState.names,
                            includeWeight: loraState.includeWeight,
                            capabilities,
                            profileMap,
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
                            executedCalls.push({
                                id: callId,
                                name: rawCall.name,
                                args: rawCall.args,
                                result: {
                                    ok: true,
                                    queued: true,
                                    insert_after: accepted.insertAfter,
                                    insert_before: accepted.insertBefore,
                                },
                            });
                        } else if (selection.rejected.length > 0) {
                            const rej = selection.rejected[0];
                            roundRejected.push(rej);
                            executedCalls.push({
                                id: callId,
                                name: rawCall.name,
                                args: rawCall.args,
                                result: {
                                    ok: false,
                                    error: formatActionableRejectionError(rej.reason),
                                },
                            });
                        }
                        continue;
                    }

                    roundRejected.push({ reason: 'unknown tool', call: rawCall });
                    executedCalls.push({
                        id: callId,
                        name: rawCall.name,
                        args: rawCall.args,
                        result: { ok: false, error: `Unsupported tool "${rawCall.name}".` },
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

                if (profileStore && roundRejected.length > 0 && validationRetries < MAX_VALIDATION_SELF_HEAL_RETRIES) {
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
                        const reasons = roundRejected.map(entry => rejectionLabel(entry.reason, t)).join(', ');
                        toast(`${t`Skipped image prompts`}: ${reasons}`, 'warning');
                    }
                    break;
                }

                const failure = buildPromptFailure({
                    toolCalls,
                    selection: { accepted: [], rejected: roundRejected },
                    assistantText,
                    finishReason,
                }, t);
                job.state = 'failed';
                activityJob?.setError(failure.report);
                activityJob?.finish('failed');
                releaseJob(job);
                console.error('Illustration prompt request produced no usable prompts.', failure.reason);
                notifyError(`${t`Illustration failed`}: ${failure.reason}`);
                return;
            }

            acceptedPrompts.forEach((value, index) => {
                activityJob?.addSection(`prompt-${index}`, { kind: 'prompt', title: `${t`Prompt`} ${index + 1}`, body: value.prompt });
                activityJob?.addSection(`image-${index}`, { kind: 'image', title: `${t`Image`} ${index + 1}` });
            });

            const characterName = String(message.name || '');
            const results = await Promise.allSettled(acceptedPrompts.map(value => {
                const genOptions = {
                    characterName,
                    signal: job.abortController.signal,
                    loras: value.loras,
                };
                if (value.negativePrompt) genOptions.negativePrompt = value.negativePrompt;
                if (value.aspectRatio) genOptions.aspectRatio = value.aspectRatio;
                if (Array.isArray(value.references) && value.references.length > 0) genOptions.references = value.references;
                if (Array.isArray(value.characterPrompts) && value.characterPrompts.length > 0) genOptions.characterPrompts = value.characterPrompts;
                return imageService.generate(value.prompt, genOptions).then(imageUrl => ({ value, imageUrl }));
            }));

            if (job.abortController.signal.aborted) {
                throw abortError();
            }
            if (!contextMatches(job)) {
                throw abortError();
            }

            let imageFailures = 0;
            results.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    activityJob?.updateSection(`image-${index}`, { status: 'done', meta: { imageUrl: result.value.imageUrl } });
                } else if (result.reason?.name !== 'AbortError') {
                    imageFailures += 1;
                    activityJob?.updateSection(`image-${index}`, { status: 'failed' });
                    const errorKey = `error-${index}`;
                    activityJob?.addSection(errorKey, { kind: 'error', title: `${t`Error`} ${index + 1}`, body: String(result.reason?.message || result.reason) });
                    activityJob?.updateSection(errorKey, { status: 'failed' });
                }
            });

            const records = results.map((result, index) => {
                const value = acceptedPrompts[index];
                if (result.status === 'fulfilled') {
                    return createIllustrationRecord({
                        id: makeIllustrationId(),
                        prompt: value.prompt,
                        negativePrompt: value.negativePrompt || '',
                        aspectRatio: value.aspectRatio || '',
                        references: value.references || [],
                        characterPrompts: value.characterPrompts || [],
                        imageUrl: result.value.imageUrl,
                        status: 'ready',
                        anchorAfter: value.insertAfter,
                        anchorBefore: value.insertBefore,
                        loras: value.loras,
                    });
                }
                if (result.reason?.name === 'AbortError') {
                    throw abortError();
                }
                return createIllustrationRecord({
                    id: makeIllustrationId(),
                    prompt: value.prompt,
                    negativePrompt: value.negativePrompt || '',
                    aspectRatio: value.aspectRatio || '',
                    references: value.references || [],
                    characterPrompts: value.characterPrompts || [],
                    status: 'failed',
                    error: String(result.reason?.message || result.reason),
                    anchorAfter: value.insertAfter,
                    anchorBefore: value.insertBefore,
                    loras: value.loras,
                });
            });

            job.state = 'inserting';
            const latestMessage = hooks.getChat()?.[messageId];
            if (!latestMessage) {
                throw abortError();
            }
            const applied = applyIllustrationResult({
                message: latestMessage,
                records,
                imageDisplayWidth: settings.imageDisplayWidth,
                ensureSwipes: hooks.ensureSwipes,
                failedLabel: t`Image generation failed`,
            });
            hooks.updateMessageBlock?.(messageId, latestMessage);
            await hooks.notifyMessageChanged?.(messageId);
            await hooks.saveChat();

            if (applied.missing.length > 0) {
                toast(t`Some illustrations were appended because their anchors were not found.`, 'warning');
            }
            const failures = records.filter(record => record.status === 'failed').length;
            if (failures > 0) {
                const firstError = records.find(record => record.status === 'failed')?.error;
                const message = firstError
                    ? `${t`Image generation failed for ${failures} prompt(s).`} ${firstError}`
                    : t`Image generation failed for ${failures} prompt(s).`;
                notifyError(message);
            }

            job.state = 'done';
            activityJob?.finish(imageFailures > 0 ? 'failed' : 'done');
            releaseJob(job);
        } catch (error) {
            const aborted = error?.name === 'AbortError' || job.abortController.signal.aborted;
            releaseJob(job);
            if (aborted) {
                job.state = 'cancelled';
                job.activityJob?.finish('aborted');
                return;
            }
            job.state = 'failed';
            job.activityJob?.setError(String(error?.message || error));
            job.activityJob?.finish('failed');
            console.error('Illustration task failed.', error);
            notifyError(`${t`Illustration failed`}: ${error?.message || error}`);
        }
    }

    async function runForLastAssistantMessage() {
        const found = getLastAssistantMessage(hooks.getChat());
        if (!found) {
            toast(t`No assistant message to illustrate.`, 'warning');
            return;
        }
        await runForMessage({ messageId: found.index, source: 'manual' });
    }

    function cancelForMessage(messageId, swipeId = undefined) {
        for (const job of [...jobs.values()]) {
            if (job.messageId !== messageId) {
                continue;
            }
            if (swipeId !== undefined && job.swipeId !== swipeId) {
                continue;
            }
            cancelJob(job);
        }
    }

    function cancelAll() {
        for (const job of [...jobs.values()]) {
            cancelJob(job);
        }
    }

    function cancelInvalidJobs(chatLength) {
        for (const job of [...jobs.values()]) {
            const outOfRange = Number.isInteger(chatLength) && job.messageId >= chatLength;
            if (outOfRange || !contextMatches(job)) {
                cancelJob(job);
            }
        }
    }

    async function handleMessageReceived(messageId, type) {
        if (!settings.enabled || !settings.autoGenerate) {
            return;
        }
        if (['first_message', 'command', 'extension'].includes(String(type))) {
            return;
        }
        const message = hooks.getChat()?.[messageId];
        if (!isAssistantMessage(message)) {
            return;
        }
        const swipeId = message.swipe_id ?? 0;
        if (Array.isArray(message.extra?.illustrations) && message.extra.illustrations.length > 0) {
            return;
        }
        const key = buildJobKey({ chatId: hooks.getChatId(), messageId, swipeId });
        if (jobs.has(key)) {
            return;
        }
        const dedup = `${key}:${messageFingerprint(message)}`;
        if (handled.has(dedup)) {
            return;
        }
        handled.add(dedup);
        await runForMessage({ messageId, source: 'auto' });
    }

    return {
        runForMessage,
        runForLastAssistantMessage,
        cancelForMessage,
        cancelAll,
        cancelInvalidJobs,
        handleMessageReceived,
    };
}
