import { Popup, POPUP_TYPE, POPUP_RESULT, callGenericPopup } from '../../../popup.js';
import {
    appendIllustrationRecords,
    collectVersionTree,
    createIllustrationRecord,
    getIllustrationRecord,
    removeIllustrationRecord,
    switchMessageIllustrationVersion,
    syncMessageSwipeData,
} from './records.js';
import { buildImageTag, escapeHtml, insertTagsAtAnchors, replaceIllustrationMarkup } from './message.js';
import { emitMessageChanged } from './message-events.js';
import { makeIllustrationId } from './presets.js';
import { messageFingerprint } from './pipeline.js';
import { resolveReplayLoras } from '../lora/tool.js';
import { deleteMediaFromServer } from '../../../chats.js';

export function initIllustrationActions({ context, pipeline, imageService, settings, ensureSwipes, toast, notifyError, t }) {
    const actionControllers = new Map();
    const reportError = typeof notifyError === 'function'
        ? notifyError
        : message => toast(message, 'error');

    function cancelMatching(predicate) {
        for (const [key, controller] of [...actionControllers]) {
            if (!predicate(key)) {
                continue;
            }
            actionControllers.delete(key);
            controller.abort('Illustration action cancelled');
        }
    }

    function cancelForMessage(messageId, swipeId = undefined) {
        cancelMatching(key => {
            const [id, swipe] = key.split(':').map(Number);
            return id === messageId && (swipeId === undefined || swipe === swipeId);
        });
    }

    function cancelFrom(chatLength) {
        cancelMatching(key => Number(key.split(':')[0]) >= chatLength);
    }

    function cancelAll() {
        cancelMatching(() => true);
    }

    function resolveTarget(target) {
        const element = target?.closest?.('[data-illustration-id]');
        const mes = element?.closest('.mes');
        if (!element || !mes) {
            return null;
        }
        const messageId = Number(mes.getAttribute('mesid'));
        if (!Number.isInteger(messageId) || messageId < 0) {
            return null;
        }
        const message = context.chat?.[messageId];
        const record = getIllustrationRecord(message, element.getAttribute('data-illustration-id'));
        if (!message || !record) {
            return null;
        }
        return { element, messageId, message, record };
    }

    function closeIfOpen(popup) {
        return popup.complete(POPUP_RESULT.AFFIRMATIVE).catch(() => {});
    }

    async function generateChildRecord({
        messageId,
        parent,
        replaceRecord = parent,
        prompt,
        overrideReferences = undefined,
    }) {
        const chatId = context.chatId;
        const message = context.chat?.[messageId];
        if (!message) {
            throw new Error('Message not found.');
        }
        const savedLoras = Array.isArray(parent?.loras) ? parent.loras : [];
        const savedReferences = overrideReferences !== undefined
            ? overrideReferences
            : (Array.isArray(parent?.references) ? parent.references : []);
        const savedNegative = String(parent?.negativePrompt || '');
        const savedAspectRatio = String(parent?.aspectRatio || '');
        const savedCharPrompts = Array.isArray(parent?.characterPrompts) ? parent.characterPrompts : [];
        const swipeId = message.swipe_id ?? 0;
        const beforeFingerprint = messageFingerprint(message);
        pipeline.cancelForMessage?.(messageId, swipeId);
        cancelForMessage(messageId, swipeId);
        const controller = new AbortController();
        const controllerKey = `${messageId}:${swipeId}`;
        actionControllers.set(controllerKey, controller);

        let loras = [];
        let imageUrl;
        try {
            if (savedLoras.length > 0) {
                const loraState = await imageService.getAvailableLoras();
                loras = resolveReplayLoras(savedLoras, loraState.names, dropped => {
                    toast(t`Some LoRAs are unavailable and were skipped: ${dropped.join(', ')}`, 'warning');
                }).loras;
            }
            imageUrl = await imageService.generate(prompt, {
                characterName: String(message.name || ''),
                negativePrompt: savedNegative,
                aspectRatio: savedAspectRatio || undefined,
                references: savedReferences.length > 0 ? savedReferences : undefined,
                characterPrompts: savedCharPrompts.length > 0 ? savedCharPrompts : undefined,
                signal: controller.signal,
                loras,
            });
        } finally {
            if (actionControllers.get(controllerKey) === controller) {
                actionControllers.delete(controllerKey);
            }
        }

        if (context.chatId !== chatId) {
            throw new Error('Chat changed, generated image discarded.');
        }
        const currentMessage = context.chat?.[messageId];
        if (!currentMessage) {
            throw new Error('Message not found.');
        }
        if ((currentMessage.swipe_id ?? 0) !== swipeId || messageFingerprint(currentMessage) !== beforeFingerprint) {
            throw new Error('Message changed, generated image discarded.');
        }

        const record = createIllustrationRecord({
            id: makeIllustrationId(),
            prompt,
            negativePrompt: savedNegative,
            aspectRatio: savedAspectRatio,
            references: savedReferences,
            characterPrompts: savedCharPrompts,
            locked: Boolean(replaceRecord.locked),
            imageUrl,
            status: 'ready',
            parentId: parent.id,
            anchorAfter: replaceRecord.anchorAfter,
            anchorBefore: replaceRecord.anchorBefore,
            loras,
        });
        const html = buildImageTag({
            id: record.id,
            imageUrl: record.imageUrl,
            prompt: record.prompt,
            width: settings.imageDisplayWidth,
        });
        if (replaceRecord.status === 'failed') {
            // Failed badges are session-only and never enter message text, so
            // place the replacement at the original anchors instead.
            const replaced = replaceIllustrationMarkup(currentMessage.mes, replaceRecord.id, html);
            currentMessage.mes = replaced !== currentMessage.mes
                ? replaced
                : insertTagsAtAnchors(String(currentMessage.mes || ''), [{
                    id: record.id,
                    html,
                    insertAfter: replaceRecord.anchorAfter,
                    insertBefore: replaceRecord.anchorBefore,
                }]).text;
            removeIllustrationRecord(currentMessage, replaceRecord.id);
        } else {
            currentMessage.mes = replaceIllustrationMarkup(currentMessage.mes, replaceRecord.id, html);
        }
        appendIllustrationRecords(currentMessage, [record]);
        syncMessageSwipeData(currentMessage, ensureSwipes);
        context.updateMessageBlock(messageId, currentMessage);
        await emitMessageChanged(context, messageId);
        await context.saveChat();
        return record;
    }

    async function requestPrompt(initialPrompt, titleLabel = t`Image prompt`) {
        const result = await callGenericPopup(titleLabel, POPUP_TYPE.INPUT, initialPrompt, { rows: 6 });
        if (result === false || result === null || result === undefined) {
            return null;
        }
        const trimmed = String(result).trim();
        if (!trimmed) {
            toast(t`The image prompt is empty.`, 'warning');
            return null;
        }
        return trimmed;
    }

    async function runGeneration(action, { messageId, record, replaceRecord, prompt, overrideReferences }) {
        try {
            await generateChildRecord({ messageId, parent: record, replaceRecord, prompt, overrideReferences });
        } catch (error) {
            if (error?.name === 'AbortError') {
                return;
            }
            console.error('Illustration action failed.', error);
            reportError(`${t`Illustration failed`}: ${error?.message || error}`);
        }
    }

    async function showActions(target) {
        const resolved = resolveTarget(target);
        if (!resolved) {
            return false;
        }
        const { messageId, record } = resolved;
        let supportsSourceImage = false;
        if (record.status === 'ready' && record.imageUrl && typeof imageService.getCapabilities === 'function') {
            try {
                const caps = await imageService.getCapabilities();
                supportsSourceImage = Boolean(caps?.supportsSourceImage);
            } catch {
                supportsSourceImage = false;
            }
        }

        const isFailed = record.status === 'failed';
        const lockLabel = record.locked ? t`Unlock illustration` : t`Lock illustration`;
        const editFromImageBtn = supportsSourceImage
            ? `<div id="sd_illustration_action_edit_from_image" class="menu_button">${escapeHtml(t`Edit from this image`)}</div>`
            : '';
        // Failed badges are session-only and have no persisted version tree.
        const lockBtn = isFailed
            ? ''
            : `<div id="sd_illustration_action_toggle_lock" class="menu_button">${escapeHtml(lockLabel)}</div>`;
        const historyBtn = isFailed
            ? ''
            : `<div id="sd_illustration_action_history" class="menu_button">${escapeHtml(t`History`)}</div>`;

        const html = `
            <div id="sd_illustration_actions" class="sd_illustration_actions">
                <div id="sd_illustration_actions_prompt" class="sd_illustration_actions_prompt" title="${escapeHtml(record.prompt)}">${escapeHtml(record.prompt)}</div>
                <div class="sd_illustration_actions_buttons">
                    <div id="sd_illustration_action_regenerate" class="menu_button">${escapeHtml(t`Regenerate`)}</div>
                    <div id="sd_illustration_action_edit_prompt" class="menu_button">${escapeHtml(t`Edit prompt`)}</div>
                    ${editFromImageBtn}
                    ${lockBtn}
                    ${historyBtn}
                    <div id="sd_illustration_action_delete" class="menu_button">${escapeHtml(t`Delete`)}</div>
                </div>
            </div>`;
        const popup = new Popup(html, POPUP_TYPE.DISPLAY, '', {
            okButton: false,
            cancelButton: false,
        });
        popup.show();
        const $root = $('#sd_illustration_actions');

        $root.on('click', '#sd_illustration_action_regenerate', async () => {
            await closeIfOpen(popup);
            await runGeneration('regenerate', { messageId, record, prompt: record.prompt });
        });

        $root.on('click', '#sd_illustration_action_edit_prompt', async () => {
            await closeIfOpen(popup);
            const prompt = await requestPrompt(record.prompt);
            if (!prompt) {
                return;
            }
            await runGeneration('edit', { messageId, record, prompt });
        });

        $root.on('click', '#sd_illustration_action_edit_from_image', async () => {
            await closeIfOpen(popup);
            const instruction = await requestPrompt('', t`Edit instruction`);
            if (!instruction) {
                return;
            }
            await runGeneration('source_edit', {
                messageId,
                record,
                prompt: instruction,
                overrideReferences: [{ imagePath: record.imageUrl, role: 'source' }],
            });
        });

        $root.on('click', '#sd_illustration_action_toggle_lock', async () => {
            await closeIfOpen(popup);
            const message = context.chat?.[messageId];
            const liveRecord = getIllustrationRecord(message, record.id);
            if (!message || !liveRecord) {
                return;
            }
            liveRecord.locked = !liveRecord.locked;
            syncMessageSwipeData(message, ensureSwipes);
            context.updateMessageBlock(messageId, message);
            await emitMessageChanged(context, messageId);
            await context.saveChat();
        });

        $root.on('click', '#sd_illustration_action_history', async () => {
            await closeIfOpen(popup);
            const message = context.chat?.[messageId];
            const current = getIllustrationRecord(message, record.id);
            if (!current) {
                return;
            }
            const history = collectVersionTree(message, current);
            const items = history.map((entry, index) => {
                const isActive = entry.id === current.id;
                const thumbHtml = entry.imageUrl
                    ? `<img class="sd_illustration_history_thumb" src="${escapeHtml(entry.imageUrl)}" alt="${escapeHtml(entry.prompt)}" data-illustration-switch-id="${escapeHtml(entry.id)}" style="max-width:72px;max-height:72px;object-fit:cover;border-radius:4px;cursor:pointer;" />`
                    : '';
                const switchBtnHtml = isActive
                    ? `<span class="sd_illustration_history_active_badge">${escapeHtml(t`Current version`)}</span>`
                    : `<div class="menu_button sd_illustration_history_switch" data-illustration-switch-id="${escapeHtml(entry.id)}">${escapeHtml(t`Use this version`)}</div>`;
                return `
                    <div class="sd_illustration_history_row flex-container alignItemsCenter gap10 marginTopBot5" data-version-id="${escapeHtml(entry.id)}">
                        ${thumbHtml}
                        <div class="sd_illustration_history_prompt flex1" data-illustration-history-id="${escapeHtml(entry.id)}">
                            <span class="sd_illustration_history_index">${index + 1}</span>${escapeHtml(entry.prompt)}
                        </div>
                        ${switchBtnHtml}
                    </div>`;
            });
            const historyHtml = `
                <div id="sd_illustration_history" class="sd_illustration_history">
                    <div id="sd_illustration_history_list" class="sd_illustration_history_list">${items.join('')}</div>
                    <div class="sd_illustration_actions_buttons">
                        <div id="sd_illustration_history_close" class="menu_button">${escapeHtml(t`Close`)}</div>
                    </div>
                </div>`;
            const historyPopup = new Popup(historyHtml, POPUP_TYPE.DISPLAY, '', {
                okButton: false,
                cancelButton: false,
            });
            historyPopup.show();
            $('#sd_illustration_history_close').on('click', () => historyPopup.complete(POPUP_RESULT.AFFIRMATIVE));

            $('#sd_illustration_history_list').on('click', '[data-illustration-switch-id]', async function (e) {
                e.stopPropagation();
                const targetId = String($(this).attr('data-illustration-switch-id') || '');
                const liveMessage = context.chat?.[messageId];
                if (!liveMessage || !targetId || targetId === current.id) {
                    return;
                }
                const switched = switchMessageIllustrationVersion({
                    message: liveMessage,
                    fromId: current.id,
                    toId: targetId,
                    imageDisplayWidth: settings.imageDisplayWidth,
                    ensureSwipes,
                });
                await historyPopup.complete(POPUP_RESULT.AFFIRMATIVE);
                if (switched) {
                    context.updateMessageBlock(messageId, liveMessage);
                    await emitMessageChanged(context, messageId);
                    await context.saveChat();
                }
            });

            $('#sd_illustration_history_list').on('click', '[data-illustration-history-id]', async function () {
                const selectedId = String($(this).attr('data-illustration-history-id') || '');
                const selected = history.find(entry => entry.id === selectedId);
                if (!selected) {
                    return;
                }
                await historyPopup.complete(POPUP_RESULT.AFFIRMATIVE);
                const prompt = await requestPrompt(selected.prompt);
                if (!prompt) {
                    return;
                }
                await runGeneration('history', { messageId, record: selected, replaceRecord: record, prompt });
            });
        });

        $root.on('click', '#sd_illustration_action_delete', async () => {
            await closeIfOpen(popup);
            const message = context.chat?.[messageId];
            const current = getIllustrationRecord(message, record.id);
            if (!current) {
                return;
            }
            const deleteHtml = `
                <div id="sd_illustration_delete" class="sd_illustration_delete">
                    <div>${escapeHtml(t`Delete this illustration?`)}</div>
                    <label class="checkbox_label" for="sd_illustration_delete_files">
                        <input id="sd_illustration_delete_files" type="checkbox" />
                        <span>${escapeHtml(t`Also delete server image files`)}</span>
                    </label>
                    <div class="sd_illustration_actions_buttons">
                        <div id="sd_illustration_delete_confirm" class="menu_button">${escapeHtml(t`Delete`)}</div>
                        <div id="sd_illustration_delete_cancel" class="menu_button">${escapeHtml(t`Cancel`)}</div>
                    </div>
                </div>`;
            const deletePopup = new Popup(deleteHtml, POPUP_TYPE.DISPLAY, '', {
                okButton: false,
                cancelButton: false,
            });
            deletePopup.show();
            const $deleteRoot = $('#sd_illustration_delete');
            $deleteRoot.on('click', '#sd_illustration_delete_cancel', () => deletePopup.complete(POPUP_RESULT.CANCELLED));
            $deleteRoot.on('click', '#sd_illustration_delete_confirm', async () => {
                const deleteFiles = !!$deleteRoot.find('#sd_illustration_delete_files').prop('checked');
                await deletePopup.complete(POPUP_RESULT.AFFIRMATIVE);
                await deleteRecord({ messageId, record: current, deleteFiles });
            });
        });

        return true;
    }

    async function deleteRecord({ messageId, record, deleteFiles }) {
        const message = context.chat?.[messageId];
        if (!message) {
            return;
        }
        pipeline.cancelForMessage?.(messageId, message.swipe_id ?? 0);
        const removed = removeIllustrationRecord(message, record.id);
        if (removed.length === 0) {
            return;
        }
        const parent = record.parentId ? getIllustrationRecord(message, record.parentId) : null;
        const replacement = parent
            ? buildImageTag({
                id: parent.id,
                imageUrl: parent.imageUrl,
                prompt: parent.prompt,
                width: settings.imageDisplayWidth,
            })
            : '';
        let text = String(message.mes || '');
        for (const entry of removed) {
            text = replaceIllustrationMarkup(text, entry.id, entry.id === record.id ? replacement : '');
        }
        message.mes = text;
        syncMessageSwipeData(message, ensureSwipes);
        context.updateMessageBlock(messageId, message);
        await emitMessageChanged(context, messageId);
        await context.saveChat();

        if (deleteFiles) {
            const files = removed.map(entry => entry.imageUrl).filter(Boolean);
            const results = await Promise.all(files.map(async imageUrl => ({
                imageUrl,
                deleted: await deleteMediaFromServer(imageUrl, true),
            })));
            const failed = results.filter(result => !result.deleted).map(result => result.imageUrl);
            if (failed.length > 0) {
                toast(`${t`Could not delete server image files`}: ${failed.join(', ')}`, 'error');
            }
        }
    }

    $('#chat').on('click', '.mes_text [data-illustration-id]', function (event) {
        event.preventDefault();
        void showActions(this);
    });

    return { handleClick: showActions, cancelForMessage, cancelFrom, cancelAll };
}
