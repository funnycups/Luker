import { buildIllustrationContext, buildIllustrationTaskMessages, requestIllustrationPrompts } from './task.js';
import { selectPromptCalls } from './tools.js';
import { applyIllustrationResult, createIllustrationRecord, syncMessageSwipeData } from './records.js';
import { getPresetById } from './settings.js';
import { makeIllustrationId } from './presets.js';
import { stripIllustrationMarkup } from './message.js';

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

export function createIllustrationPipeline({ context, imageService, settings, hooks }) {
    const jobs = new Map();
    const handled = new Set();
    const t = hooks.t ?? (text => text);
    const toast = (message, type = 'error') => hooks.toast?.(message, type);

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
            toast(t`No illustration preset is selected.`);
            return;
        }
        if (!String(preset.illustrationPrompt || '').trim()) {
            toast(t`The illustration prompt is empty.`);
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
            message.mes = stripIllustrationMarkup(message.mes);
            message.extra.illustrations = [];
            syncMessageSwipeData(message, hooks.ensureSwipes);
            hooks.updateMessageBlock?.(messageId, message);
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
            imageConfigFingerprint: hooks.imageConfigFingerprint(),
            source,
            presetId: preset.id,
            abortController: new AbortController(),
            state: 'prompting',
        };
        jobs.set(key, job);

        try {
            const snapshotText = String(message.mes || '');
            const built = buildIllustrationContext({
                chat,
                messageId,
                contextMessageCount: settings.contextMessageCount,
                stripMarkup: stripIllustrationMarkup,
            });
            const memoryRecall = await readMemoryRecall();
            if (!contextMatches(job)) {
                throw abortError();
            }

            const taskMessages = buildIllustrationTaskMessages({
                preset,
                context: built.context,
                current: built.current,
                memoryRecall,
            });

            job.state = 'generating';
            const toolCalls = await requestIllustrationPrompts({
                context,
                preset,
                taskMessages,
                abortSignal: job.abortController.signal,
            });
            if (!contextMatches(job)) {
                throw abortError();
            }

            const selection = selectPromptCalls(toolCalls, {
                maxPrompts: settings.maxPromptsPerMessage,
                messageText: snapshotText,
            });
            if (selection.rejected.length > 0) {
                const reasons = selection.rejected.map(entry => entry.reason).join(', ');
                toast(`${t`Skipped image prompts`}: ${reasons}`, 'warning');
            }
            if (selection.truncated > 0) {
                toast(t`Some image prompts were dropped because the message limit was reached.`, 'warning');
            }
            if (selection.accepted.length === 0) {
                job.state = 'done';
                releaseJob(job);
                return;
            }

            const characterName = String(message.name || '');
            const results = await Promise.allSettled(selection.accepted.map(value => imageService.generate(value.prompt, {
                characterName,
                signal: job.abortController.signal,
                expectedFingerprint: job.imageConfigFingerprint,
            }).then(imageUrl => ({ value, imageUrl }))));

            const configChange = results.find(result => result.status === 'rejected' && result.reason?.code === 'image_config_changed');
            if (configChange) {
                throw configChange.reason;
            }

            if (job.abortController.signal.aborted) {
                throw abortError();
            }
            if (!contextMatches(job)) {
                throw abortError();
            }

            const records = results.map((result, index) => {
                const value = selection.accepted[index];
                if (result.status === 'fulfilled') {
                    return createIllustrationRecord({
                        id: makeIllustrationId(),
                        prompt: value.prompt,
                        imageUrl: result.value.imageUrl,
                        status: 'ready',
                        anchorAfter: value.insertAfter,
                        anchorBefore: value.insertBefore,
                    });
                }
                if (result.reason?.name === 'AbortError') {
                    throw abortError();
                }
                return createIllustrationRecord({
                    id: makeIllustrationId(),
                    prompt: value.prompt,
                    status: 'failed',
                    error: String(result.reason?.message || result.reason),
                    anchorAfter: value.insertAfter,
                    anchorBefore: value.insertBefore,
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
            await hooks.saveChat();

            if (applied.missing.length > 0) {
                toast(t`Some illustrations were appended because their anchors were not found.`, 'warning');
            }
            const failures = records.filter(record => record.status === 'failed').length;
            if (failures > 0) {
                toast(t`Image generation failed for ${failures} prompt(s).`, 'error');
            }

            job.state = 'done';
            releaseJob(job);
        } catch (error) {
            const aborted = error?.name === 'AbortError' || job.abortController.signal.aborted;
            releaseJob(job);
            if (error?.code === 'image_config_changed') {
                job.state = 'cancelled';
                toast(t`Image generation configuration changed. This round produced no image.`, 'warning');
                return;
            }
            if (aborted) {
                job.state = 'cancelled';
                return;
            }
            job.state = 'failed';
            console.error('Illustration task failed.', error);
            toast(`${t`Illustration failed`}: ${error?.message || error}`, 'error');
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
