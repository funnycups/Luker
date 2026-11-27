// SPDX-License-Identifier: AGPL-3.0-or-later

export const autoModeOptions = {
    NONE: 'none',
    RESPONSES: 'responses',
    INPUT: 'inputs',
    BOTH: 'both',
};

const incomingTypes = [autoModeOptions.RESPONSES, autoModeOptions.BOTH];
const outgoingTypes = [autoModeOptions.INPUT, autoModeOptions.BOTH];

/**
 * Pure controller for message/reasoning/impersonate translation flows and activity-guard leases.
 */
export function createTranslateController({
    getSettings,
    getContext,
    getRequestHeaders,
    getSecretState,
    substituteParams,
    updateMessageBlock,
    updateReasoningUI,
    splitRecursive,
    t,
    getJQuery = () => globalThis.$,
    getToastr = () => globalThis.toastr,
    fetchImpl = (...args) => globalThis.fetch(...args),
}) {
    const recentlyEditedMessageIds = new Set();

    async function withTranslateActivity(fn) {
        const guard = getContext()?.activityGuard;
        if (typeof guard?.run !== 'function') {
            return await fn();
        }
        return await guard.run({
            source: 'translate:run',
            label: t`Message translation`,
            scope: 'chat',
        }, fn);
    }

    function isGeneratingSwipe(messageId) {
        const $ = getJQuery();
        return $(`#chat .mes[mesid="${messageId}"] .mes_text`).text() === '...';
    }

    async function translateProviderOneRing(text, lang) {
        const settings = getSettings();
        const from_lang = lang == settings.internal_language
            ? settings.target_language
            : settings.internal_language;

        const response = await fetchImpl('/api/translate/onering', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ text: text, from_lang: from_lang, to_lang: lang }),
        });

        if (response.ok) {
            return await response.text();
        }

        throw new Error(response.statusText);
    }

    async function translateProviderLibre(text, lang) {
        const response = await fetchImpl('/api/translate/libre', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ text: text, lang: lang }),
        });

        if (response.ok) {
            return await response.text();
        }

        throw new Error(response.statusText);
    }

    async function translateProviderGoogle(text, lang) {
        const response = await fetchImpl('/api/translate/google', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ text: text, lang: lang }),
        });

        if (response.ok) {
            return await response.text();
        }

        throw new Error(response.statusText);
    }

    async function translateProviderLingva(text, lang) {
        const response = await fetchImpl('/api/translate/lingva', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ text: text, lang: lang }),
        });

        if (response.ok) {
            return await response.text();
        }

        throw new Error(response.statusText);
    }

    async function translateProviderDeepl(text, lang) {
        if (!getSecretState()?.deepl) {
            throw new Error('No DeepL API key');
        }

        const endpoint = getSettings().deepl_endpoint || 'free';
        const response = await fetchImpl('/api/translate/deepl', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ text: text, lang: lang, endpoint: endpoint }),
        });

        if (response.ok) {
            return await response.text();
        }

        throw new Error(response.statusText);
    }

    async function translateProviderDeepLX(text, lang) {
        const response = await fetchImpl('/api/translate/deeplx', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ text: text, lang: lang }),
        });

        if (response.ok) {
            return await response.text();
        }

        throw new Error(response.statusText);
    }

    async function translateProviderBing(text, lang) {
        const response = await fetchImpl('/api/translate/bing', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ text: text, lang: lang }),
        });

        if (response.ok) {
            return await response.text();
        }

        throw new Error(response.statusText);
    }

    async function translateProviderYandex(text, lang) {
        let chunks = [];
        const chunkSize = 5000;
        if (text.length <= chunkSize) {
            chunks.push(text);
        } else {
            chunks = splitRecursive(text, chunkSize);
        }
        const response = await fetchImpl('/api/translate/yandex', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ chunks: chunks, lang: lang }),
        });

        if (response.ok) {
            return await response.text();
        }

        throw new Error(response.statusText);
    }

    async function chunkedTranslate(text, lang, translateFn, chunkSize = 5000) {
        if (text.length <= chunkSize) {
            return await translateFn(text, lang);
        }

        const chunks = splitRecursive(text, chunkSize);

        let result = '';
        for (const chunk of chunks) {
            result += await translateFn(chunk, lang);
        }
        return result;
    }

    async function translateInner(text, lang, provider) {
        if (text == '') {
            return '';
        }
        if (!provider) {
            provider = getSettings().provider;
        }
        switch (provider) {
            case 'libre':
                return await translateProviderLibre(text, lang);
            case 'google':
                return await chunkedTranslate(text, lang, translateProviderGoogle, 5000);
            case 'lingva':
                return await chunkedTranslate(text, lang, translateProviderLingva, 5000);
            case 'deepl':
                return await translateProviderDeepl(text, lang);
            case 'deeplx':
                return await chunkedTranslate(text, lang, translateProviderDeepLX, 1500);
            case 'oneringtranslator':
                return await translateProviderOneRing(text, lang);
            case 'bing':
                return await chunkedTranslate(text, lang, translateProviderBing, 1000);
            case 'yandex':
                return await translateProviderYandex(text, lang);
            default:
                console.error('Unknown translation provider', provider);
                return text;
        }
    }

    async function translate(text, lang, provider = null) {
        try {
            if (text == '') {
                return '';
            }

            const settings = getSettings();
            if (!lang) {
                lang = settings.target_language;
            }

            if (!provider) {
                provider = settings.provider;
            }

            const chunks = text.split(/!\[.*?]\([^)]*\)/);
            const links = [...text.matchAll(/!\[.*?]\([^)]*\)/g)];

            let result = '';
            for (let i = 0; i < chunks.length; i++) {
                result += await translateInner(chunks[i], lang, provider);
                if (i < links.length) result += links[i][0];
            }

            return result;
        } catch (error) {
            console.log(error);
            getToastr()?.error(String(error), 'Failed to translate message');
        }
    }

    async function translateImpersonate() {
        return await withTranslateActivity(async () => {
            const $ = getJQuery();
            const sendTextArea = $('#send_textarea');
            const text = sendTextArea.val().toString();
            const translatedText = await translate(text, getSettings().target_language);
            sendTextArea.val(translatedText);
        });
    }

    async function translateIncomingMessageInner(messageId) {
        const context = getContext();
        const message = context.chat[messageId];

        if (!message) {
            return;
        }

        if (typeof message.extra !== 'object') {
            message.extra = {};
        }

        if (isGeneratingSwipe(messageId)) {
            return;
        }

        const textToTranslate = substituteParams(message.mes, { name2Override: message.name });
        const translation = await translate(textToTranslate, getSettings().target_language);
        message.extra.display_text = translation;

        updateMessageBlock(Number(messageId), message);
    }

    async function translateIncomingMessage(messageId) {
        return await withTranslateActivity(() => translateIncomingMessageInner(messageId));
    }

    async function translateIncomingMessageReasoningInner(messageId) {
        const context = getContext();
        const message = context.chat[messageId];

        if (!message) {
            return false;
        }

        if (typeof message.extra !== 'object') {
            message.extra = {};
        }

        if (!message.extra.reasoning || isGeneratingSwipe(messageId)) {
            return false;
        }

        const textToTranslate = substituteParams(message.extra.reasoning, { name2Override: message.name });
        const translation = await translate(textToTranslate, getSettings().target_language);
        message.extra.reasoning_display_text = translation;

        updateReasoningUI(Number(messageId));
        return true;
    }

    async function translateIncomingMessageReasoning(messageId) {
        return await withTranslateActivity(() => translateIncomingMessageReasoningInner(messageId));
    }

    async function translateOutgoingMessage(messageId) {
        return await withTranslateActivity(async () => {
            const context = getContext();
            const message = context.chat[messageId];

            if (typeof message.extra !== 'object') {
                message.extra = {};
            }

            const originalText = message.mes;
            message.extra.display_text = originalText;
            message.mes = await translate(originalText, getSettings().internal_language);
            updateMessageBlock(messageId, message);

            console.log('translateOutgoingMessage', messageId);
        });
    }

    function shouldTranslate(types) {
        return types.includes(getSettings().auto_mode);
    }

    function createEventHandler(translateFunction, shouldTranslateFunction) {
        return async (data) => {
            if (shouldTranslateFunction()) {
                await translateFunction(data);
            }
        };
    }

    async function translateMessageEdit(messageId, { didContentEdit = false } = {}) {
        const context = getContext();
        const message = context.chat[messageId];
        if (!message) {
            return;
        }

        if (!didContentEdit) {
            if (message.extra?.display_text) {
                updateMessageBlock(messageId, message);
            }
            return;
        }

        const shouldClearTranslation = message.is_system
            || (getSettings().auto_mode == autoModeOptions.NONE && Boolean(message.extra?.display_text));
        const shouldRunTranslation = !shouldClearTranslation
            && ((message.is_user && shouldTranslate(outgoingTypes)) || (!message.is_user && shouldTranslate(incomingTypes)));

        if (!shouldClearTranslation && !shouldRunTranslation) {
            return;
        }

        return await withTranslateActivity(async () => {
            if (shouldClearTranslation) {
                if (message.extra) {
                    delete message.extra.display_text;
                }
                updateMessageBlock(messageId, message);
            } else {
                await translateIncomingMessageInner(messageId);
            }

            await context.saveChat();
        });
    }

    async function translateMessageReasoningEdit(messageId) {
        const context = getContext();
        const message = context.chat[messageId];
        if (!message) {
            return;
        }

        const shouldClearTranslation = message.is_system
            || (getSettings().auto_mode == autoModeOptions.NONE && Boolean(message.extra?.reasoning_display_text));
        const shouldRunTranslation = !shouldClearTranslation
            && ((message.is_user && shouldTranslate(outgoingTypes)) || (!message.is_user && shouldTranslate(incomingTypes)))
            && Boolean(message.extra?.reasoning)
            && !isGeneratingSwipe(messageId);

        if (!shouldClearTranslation && !shouldRunTranslation) {
            return;
        }

        return await withTranslateActivity(async () => {
            let anyChange = false;
            if (shouldClearTranslation) {
                if (message.extra) {
                    delete message.extra.reasoning_display_text;
                }
                updateReasoningUI(Number(messageId));
                anyChange = true;
            } else {
                anyChange = await translateIncomingMessageReasoningInner(messageId);
            }

            if (anyChange) {
                await context.saveChat();
            }
        });
    }

    async function removeReasoningDisplayText(messageId) {
        const context = getContext();
        const message = context.chat[messageId];
        if (message.extra?.reasoning_display_text) {
            delete message.extra.reasoning_display_text;
            updateReasoningUI(Number(messageId));
            await context.saveChat();
        }
    }

    const handleIncomingMessage = createEventHandler(async (messageId) => {
        await translateIncomingMessageReasoning(messageId);
        await translateIncomingMessage(messageId);
    }, () => shouldTranslate(incomingTypes));
    const handleOutgoingMessage = createEventHandler(translateOutgoingMessage, () => shouldTranslate(outgoingTypes));
    const handleImpersonateReady = createEventHandler(translateImpersonate, () => shouldTranslate(incomingTypes));
    const handleMessageEdited = createEventHandler((messageId) => {
        const normalizedMessageId = Number(messageId);
        if (Number.isInteger(normalizedMessageId) && normalizedMessageId >= 0) {
            recentlyEditedMessageIds.add(normalizedMessageId);
        }
    }, () => true);
    const handleMessageUpdate = createEventHandler(async (messageId) => {
        const normalizedMessageId = Number(messageId);
        const didContentEdit = recentlyEditedMessageIds.delete(normalizedMessageId);
        await translateMessageEdit(normalizedMessageId, { didContentEdit });
    }, () => true);
    const handleMessageReasoningEdit = createEventHandler(translateMessageReasoningEdit, () => true);
    const handleMessageReasoningDelete = createEventHandler(removeReasoningDisplayText, () => true);
    const clearRecentlyEditedMessages = () => recentlyEditedMessageIds.clear();

    return {
        withTranslateActivity,
        translate,
        translateImpersonate,
        translateIncomingMessage,
        translateIncomingMessageReasoning,
        translateOutgoingMessage,
        translateMessageEdit,
        translateMessageReasoningEdit,
        removeReasoningDisplayText,
        handleIncomingMessage,
        handleOutgoingMessage,
        handleImpersonateReady,
        handleMessageEdited,
        handleMessageUpdate,
        handleMessageReasoningEdit,
        handleMessageReasoningDelete,
        clearRecentlyEditedMessages,
    };
}
