import { createCharacterProfileStore } from '../character-archive/store.js';
import {
    captureIllustrationInput,
    findLastAssistantIllustrationMessage,
    isAssistantIllustrationMessage,
} from './execution-context.js';
import { runIllustrationAgent } from './agent.js';
import { ILLUSTRATION_AGENT_TOOL_NAMES } from './tools.js';
import { applyIllustrationResult, collectVersionTree, createIllustrationRecord, syncMessageSwipeData } from './records.js';
import { getPresetById } from './settings.js';
import { makeIllustrationId } from './presets.js';
import { stripIllustrationMarkup, stripUnlockedIllustrationMarkup } from './message.js';

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

export function getLastAssistantMessage(chat) {
    return findLastAssistantIllustrationMessage(chat);
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
        if (!isAssistantIllustrationMessage(message)) {
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
            const input = await captureIllustrationInput({
                context,
                preset,
                chat,
                messageIndex: messageId,
                contextMessageCount: settings.contextMessageCount,
                imageService,
                lockedIds,
                capturePromptContext: false,
                onMemoryRecallWarning: error => {
                    toast(`${t`Memory recall is unavailable`}: ${error?.message || error}`, 'warning');
                },
            });
            if (!contextMatches(job)) {
                throw abortError();
            }

            const hasGlobalArchive = typeof context?.getGlobalState === 'function'
                && typeof context?.updateGlobalState === 'function';
            const profileStore = hasGlobalArchive ? createCharacterProfileStore(context) : null;

            const activityJob = typeof hooks.beginActivityJob === 'function'
                ? hooks.beginActivityJob({
                    kind: 'illustration',
                    messageIndex: messageId,
                    abort: () => cancelJob(job),
                })
                : null;
            job.activityJob = activityJob;
            job.state = 'generating';

            let imageFailures = 0;
            const observe = event => {
                if (!event) return;
                if (event.type === 'tool_start') {
                    if (event.name === ILLUSTRATION_AGENT_TOOL_NAMES.READ_CHARACTER_PROFILES) {
                        activityJob?.addSection(`read-profiles-${event.callId}`, {
                            kind: 'tool',
                            title: `read_character_profiles (${(event.ids || []).join(', ')})`,
                            body: JSON.stringify(event.args ?? {}),
                        });
                    } else if (event.name === ILLUSTRATION_AGENT_TOOL_NAMES.EXPLORE_CHARACTERS) {
                        const targetLabel = (event.targets || [])
                            .map(item => String(item?.name || '').trim())
                            .filter(Boolean)
                            .join(', ');
                        activityJob?.addSection(`explore-characters-${event.callId}`, {
                            kind: 'tool',
                            title: targetLabel ? `explore_characters (${targetLabel})` : 'explore_characters',
                            body: JSON.stringify(event.args ?? {}),
                        });
                    }
                    return;
                }
                if (event.type === 'tool_done') {
                    if (event.name === ILLUSTRATION_AGENT_TOOL_NAMES.READ_CHARACTER_PROFILES) {
                        activityJob?.updateSection(`read-profiles-${event.callId}`, {
                            status: 'done',
                            meta: { matched: event.matched },
                        });
                    } else if (event.name === ILLUSTRATION_AGENT_TOOL_NAMES.EXPLORE_CHARACTERS) {
                        activityJob?.updateSection(`explore-characters-${event.callId}`, {
                            status: 'done',
                            meta: { savedIds: event.savedIds || [] },
                        });
                    }
                    return;
                }
                if (event.type === 'skipped_prompts') {
                    const reasons = (event.rejected || []).map(entry => rejectionLabel(entry.reason, t)).join(', ');
                    toast(`${t`Skipped image prompts`}: ${reasons}`, 'warning');
                    return;
                }
                if (event.type === 'prompts_accepted') {
                    (event.acceptedPrompts || []).forEach((value, index) => {
                        activityJob?.addSection(`prompt-${index}`, { kind: 'prompt', title: `${t`Prompt`} ${index + 1}`, body: value.prompt });
                        activityJob?.updateSection(`prompt-${index}`, { status: 'done' });
                        activityJob?.addSection(`image-${index}`, { kind: 'image', title: `${t`Image`} ${index + 1}` });
                    });
                    return;
                }
                if (event.type === 'image_done') {
                    activityJob?.updateSection(`image-${event.index}`, { status: 'done', meta: { imageUrl: event.imageUrl } });
                    return;
                }
                if (event.type === 'image_aborted') {
                    activityJob?.updateSection(`image-${event.index}`, { status: 'aborted' });
                    return;
                }
                if (event.type === 'image_failed') {
                    imageFailures += 1;
                    activityJob?.updateSection(`image-${event.index}`, { status: 'failed' });
                    const errorKey = `error-${event.index}`;
                    activityJob?.addSection(errorKey, { kind: 'error', title: `${t`Error`} ${event.index + 1}`, body: event.error });
                    activityJob?.updateSection(errorKey, { status: 'failed' });
                }
            };

            const agentResult = await runIllustrationAgent({
                context,
                preset,
                input,
                profileStore,
                media: {
                    generate: (prompt, options) => imageService.generate(prompt, options),
                },
                observe,
                abortSignal: job.abortController.signal,
                allowExploration: true,
                checkAlive: () => {
                    if (!contextMatches(job)) {
                        throw abortError();
                    }
                },
            });

            if (agentResult.trace?.failure) {
                const failure = buildPromptFailure({
                    toolCalls: agentResult.trace.failure.toolCalls,
                    selection: { accepted: [], rejected: agentResult.trace.failure.rejected },
                    assistantText: agentResult.trace.failure.assistantText,
                    finishReason: agentResult.trace.failure.finishReason,
                }, t);
                job.state = 'failed';
                activityJob?.setError(failure.report);
                activityJob?.finish('failed');
                releaseJob(job);
                console.error('Illustration prompt request produced no usable prompts.', failure.reason);
                notifyError(`${t`Illustration failed`}: ${failure.reason}`);
                return;
            }

            const records = agentResult.results.map(item => {
                const value = item.prompt;
                if (item.status === 'ready') {
                    return createIllustrationRecord({
                        id: makeIllustrationId(),
                        prompt: value.prompt,
                        negativePrompt: value.negativePrompt || '',
                        aspectRatio: value.aspectRatio || '',
                        references: value.references || [],
                        characterPrompts: value.characterPrompts || [],
                        imageUrl: item.imageUrl,
                        status: 'ready',
                        anchorAfter: value.insertAfter,
                        anchorBefore: value.insertBefore,
                        loras: value.loras,
                    });
                }
                return createIllustrationRecord({
                    id: makeIllustrationId(),
                    prompt: value.prompt,
                    negativePrompt: value.negativePrompt || '',
                    aspectRatio: value.aspectRatio || '',
                    references: value.references || [],
                    characterPrompts: value.characterPrompts || [],
                    status: 'failed',
                    error: item.error,
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
                const errorMessage = firstError
                    ? `${t`Image generation failed for ${failures} prompt(s).`} ${firstError}`
                    : t`Image generation failed for ${failures} prompt(s).`;
                notifyError(errorMessage);
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
        if (!isAssistantIllustrationMessage(message)) {
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
