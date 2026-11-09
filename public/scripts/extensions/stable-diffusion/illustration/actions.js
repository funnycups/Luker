import { Popup, POPUP_TYPE, POPUP_RESULT, callGenericPopup } from '../../../popup.js';
import {
    appendIllustrationRecords,
    createIllustrationRecord,
    getIllustrationRecord,
    removeIllustrationRecord,
    syncMessageSwipeData,
} from './records.js';
import { buildImageTag, escapeHtml, replaceIllustrationMarkup } from './message.js';
import { makeIllustrationId } from './presets.js';
import { messageFingerprint } from './pipeline.js';
import { deleteMediaFromServer } from '../../../chats.js';

function collectHistory(message, record) {
    const chain = [];
    const seen = new Set();
    let current = record;
    while (current) {
        chain.unshift(current);
        if (!current.parentId || seen.has(current.parentId)) {
            break;
        }
        seen.add(current.id);
        current = getIllustrationRecord(message, current.parentId);
    }
    return chain;
}

export function initIllustrationActions({ context, pipeline, imageService, settings, fingerprint, ensureSwipes, toast, t }) {
    const actionControllers = new Map();

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

    async function generateChildRecord({ messageId, parent, replaceRecord = parent, prompt }) {
        const chatId = context.chatId;
        const message = context.chat?.[messageId];
        if (!message) {
            throw new Error('Message not found.');
        }
        const swipeId = message.swipe_id ?? 0;
        const beforeFingerprint = messageFingerprint(message);
        pipeline.cancelForMessage?.(messageId, swipeId);
        cancelForMessage(messageId, swipeId);
        const controller = new AbortController();
        const controllerKey = `${messageId}:${swipeId}`;
        actionControllers.set(controllerKey, controller);

        let imageUrl;
        try {
            imageUrl = await imageService.generate(prompt, {
                characterName: String(message.name || ''),
                expectedFingerprint: fingerprint(),
                signal: controller.signal,
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
            imageUrl,
            status: 'ready',
            parentId: parent.id,
            anchorAfter: replaceRecord.anchorAfter,
            anchorBefore: replaceRecord.anchorBefore,
        });
        currentMessage.mes = replaceIllustrationMarkup(currentMessage.mes, replaceRecord.id, buildImageTag({
            id: record.id,
            imageUrl: record.imageUrl,
            prompt: record.prompt,
            width: settings.imageDisplayWidth,
        }));
        appendIllustrationRecords(currentMessage, [record]);
        syncMessageSwipeData(currentMessage, ensureSwipes);
        context.updateMessageBlock(messageId, currentMessage);
        await context.saveChat();
        return record;
    }

    async function runGeneration(action, { messageId, record, replaceRecord, prompt }) {
        try {
            await generateChildRecord({ messageId, parent: record, replaceRecord, prompt });
        } catch (error) {
            if (error?.name === 'AbortError') {
                return;
            }
            console.error('Illustration action failed.', error);
            toast(`${t`Illustration failed`}: ${error?.message || error}`, 'error');
        }
    }

    async function showActions(target) {
        const resolved = resolveTarget(target);
        if (!resolved) {
            return false;
        }
        const { messageId, record } = resolved;
        const html = `
            <div id="sd_illustration_actions" class="sd_illustration_actions">
                <div id="sd_illustration_actions_prompt" class="sd_illustration_actions_prompt" title="${escapeHtml(record.prompt)}">${escapeHtml(record.prompt)}</div>
                <div class="sd_illustration_actions_buttons">
                    <div id="sd_illustration_action_regenerate" class="menu_button">${escapeHtml(t`Regenerate`)}</div>
                    <div id="sd_illustration_action_edit_prompt" class="menu_button">${escapeHtml(t`Edit prompt`)}</div>
                    <div id="sd_illustration_action_history" class="menu_button">${escapeHtml(t`History`)}</div>
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
            const prompt = await callGenericPopup(t`Image prompt`, POPUP_TYPE.INPUT, record.prompt);
            if (prompt === null || prompt === undefined) {
                return;
            }
            const trimmed = String(prompt).trim();
            if (!trimmed) {
                toast(t`The image prompt is empty.`, 'warning');
                return;
            }
            await runGeneration('edit', { messageId, record, prompt: trimmed });
        });

        $root.on('click', '#sd_illustration_action_history', async () => {
            await closeIfOpen(popup);
            const message = context.chat?.[messageId];
            const current = getIllustrationRecord(message, record.id);
            if (!current) {
                return;
            }
            const history = collectHistory(message, current);
            const items = history.map((entry, index) => `<div class="sd_illustration_history_prompt" data-illustration-history-id="${escapeHtml(entry.id)}"><span class="sd_illustration_history_index">${index + 1}</span>${escapeHtml(entry.prompt)}</div>`);
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
            $('#sd_illustration_history_list').on('click', '[data-illustration-history-id]', async function () {
                const selectedId = String($(this).attr('data-illustration-history-id') || '');
                const selected = history.find(entry => entry.id === selectedId);
                if (!selected) {
                    return;
                }
                await historyPopup.complete(POPUP_RESULT.AFFIRMATIVE);
                await runGeneration('history', { messageId, record: selected, replaceRecord: record, prompt: selected.prompt });
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
