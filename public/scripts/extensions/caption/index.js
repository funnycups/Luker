import { ensureImageFormatSupported, getBase64Async, getFileExtension, isTrueBoolean, saveBase64AsFile } from '../../utils.js';
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import { appendMediaToMessage, chat_metadata, eventSource, event_types, getRequestHeaders, saveChatConditional, saveSettingsDebounced, substituteParams } from '../../../script.js';
import { getMessageTimeStamp } from '../../RossAscends-mods.js';
import { SECRET_KEYS, secret_state } from '../../secrets.js';
import { oai_settings, POLLINATIONS_ENDPOINT } from '../../openai.js';
import { getMultimodalCaption } from '../shared.js';
import { textgen_types, textgenerationwebui_settings } from '../../textgen-settings.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { callGenericPopup, Popup, POPUP_TYPE } from '../../popup.js';
import { debounce_timeout, MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE, SCROLL_BEHAVIOR } from '../../constants.js';
import { initializePromptDefaults, requireStoredPrompt } from '../../lib/prompt-values.js';
import { t } from '../../i18n.js';
import { mountBehaviorSummary } from '../../lens-shared/behavior-summary.js';
import { buildCaptionSummaryModel } from './behavior-summary-model.js';
import { createCaptionController } from './caption-controller.js';
export { MODULE_NAME };

const MODULE_NAME = 'caption';

let captionSummaryHandle = null;

function translateSummary(text, key = null) {
    const fn = getContext()?.translate ?? globalThis.__i18n?.translate;
    return typeof fn === 'function' ? fn(String(text ?? ''), key) : String(text ?? '');
}

function readSelectDisplayLabel(selectEl) {
    if (!(selectEl instanceof HTMLSelectElement) || !selectEl.value) {
        return '';
    }
    const selected = selectEl.selectedOptions?.[0]
        || (selectEl.selectedIndex >= 0 ? selectEl.options?.[selectEl.selectedIndex] : null);
    return String(selected?.textContent || '').trim();
}

function refreshCaptionBehaviorSummary() {
    captionSummaryHandle?.refresh();
}

function mountCaptionBehaviorSummary() {
    captionSummaryHandle?.destroy();
    captionSummaryHandle = null;

    const container = document.getElementById('caption_container') || document;
    const drawerContent = container.querySelector('.caption_settings .inline-drawer-content');
    if (!drawerContent) {
        return null;
    }

    captionSummaryHandle = mountBehaviorSummary({
        id: 'caption-settings',
        root: drawerContent,
        anchor: drawerContent,
        position: 'prepend',
        ariaLabel: translateSummary('Image captioning behavior summary'),
        fields: {
            source: '#caption_source',
            multimodalApi: { selector: '#caption_multimodal_api', highlight: '.flex-container.flexFlowColumn' },
            multimodalModel: { selector: '#caption_multimodal_model', highlight: '.flex-container.flexFlowColumn' },
            customModel: { selector: '#caption_custom_model', highlight: '[data-type="custom"]' },
            ollamaCustomModel: { selector: '#caption_ollama_custom_model', highlight: '.marginTop5' },
            allowReverseProxy: { selector: '#caption_allow_reverse_proxy', highlight: '.checkbox_label' },
            altEndpointEnabled: { selector: '#caption_altEndpoint_enabled', highlight: '.checkbox_label' },
            altEndpointUrl: '#caption_altEndpoint_url',
            prompt: '#caption_prompt',
            promptAsk: { selector: '#caption_prompt_ask', highlight: '.checkbox_label' },
            template: '#caption_template',
            autoMode: { selector: '#caption_auto_mode', highlight: '.checkbox_label' },
            refineMode: { selector: '#caption_refine_mode', highlight: '.checkbox_label' },
            showInChat: { selector: '#caption_show_in_chat', highlight: '.checkbox_label' },
        },
        readState: (rootEl) => {
            const apiSel = /** @type {HTMLSelectElement|null} */ (rootEl.querySelector('#caption_multimodal_api'));
            const modelSel = /** @type {HTMLSelectElement|null} */ (rootEl.querySelector('#caption_multimodal_model'));
            return {
                source: String(rootEl.querySelector('#caption_source')?.value || extension_settings.caption?.source || 'local'),
                multimodalApi: String(apiSel?.value || extension_settings.caption?.multimodal_api || 'openai'),
                multimodalApiLabel: readSelectDisplayLabel(apiSel),
                multimodalModel: String(modelSel?.value || extension_settings.caption?.multimodal_model || ''),
                multimodalModelLabel: readSelectDisplayLabel(modelSel),
                customModel: String(rootEl.querySelector('#caption_custom_model')?.value ?? ''),
                ollamaCustomModel: String(rootEl.querySelector('#caption_ollama_custom_model')?.value ?? ''),
                currentOllamaModel: String(textgenerationwebui_settings?.ollama_model ?? ''),
                currentVllmModel: String(textgenerationwebui_settings?.vllm_model ?? ''),
                currentCustomModel: String(oai_settings?.custom_model ?? ''),
                allowReverseProxy: Boolean(rootEl.querySelector('#caption_allow_reverse_proxy')?.checked),
                reverseProxyConfigured: Boolean(oai_settings?.reverse_proxy),
                altEndpointEnabled: Boolean(rootEl.querySelector('#caption_altEndpoint_enabled')?.checked),
                altEndpointUrl: String(rootEl.querySelector('#caption_altEndpoint_url')?.value ?? ''),
                prompt: String(rootEl.querySelector('#caption_prompt')?.value ?? ''),
                promptAsk: Boolean(rootEl.querySelector('#caption_prompt_ask')?.checked),
                template: String(rootEl.querySelector('#caption_template')?.value ?? ''),
                autoMode: Boolean(rootEl.querySelector('#caption_auto_mode')?.checked),
                refineMode: Boolean(rootEl.querySelector('#caption_refine_mode')?.checked),
                showInChat: Boolean(rootEl.querySelector('#caption_show_in_chat')?.checked),
                i18n: translateSummary,
            };
        },
        build: buildCaptionSummaryModel,
    });

    return captionSummaryHandle;
}

const {
    captionExistingMessage,
    captionCommandCallback,
    handleWandFileChange,
} = createCaptionController({
    getSettings: () => extension_settings.caption,
    getContext: (...args) => getContext(...args),
    isTrueBoolean: (...args) => isTrueBoolean(...args),
    ensureImageFormatSupported: (...args) => ensureImageFormatSupported(...args),
    getBase64Async: (...args) => getBase64Async(...args),
    getFileExtension: (...args) => getFileExtension(...args),
    saveBase64AsFile: (...args) => saveBase64AsFile(...args),
    isVideoCaptioningAvailable: (...args) => isVideoCaptioningAvailable(...args),
    doCaptionRequest: (...args) => doCaptionRequest(...args),
    wrapCaptionTemplate: (...args) => wrapCaptionTemplate(...args),
    sendCaptionedMessage: (...args) => sendCaptionedMessage(...args),
    setSpinnerIcon: (...args) => setSpinnerIcon(...args),
    setImageIcon: (...args) => setImageIcon(...args),
    MEDIA_TYPE,
    t: (...args) => t(...args),
});

const PROMPT_DEFAULT = 'What\'s in this image?';
const TEMPLATE_DEFAULT = '[{{user}} sends {{char}} a picture that contains: {{caption}}]';
const GOOGLE_MODEL_MIGRATIONS = new Map([
    ['gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-lite'],
    ['gemini-3.1-flash-image-preview', 'gemini-3.1-flash-image'],
    ['gemini-3-pro-image-preview', 'gemini-3-pro-image'],
]);

/**
 * Migrates old extension settings to the new format.
 * Must keep this function for compatibility with old settings.
 */
function migrateSettings() {
    if (extension_settings.caption.local !== undefined) {
        extension_settings.caption.source = extension_settings.caption.local ? 'local' : 'extras';
    }

    delete extension_settings.caption.local;

    if (!extension_settings.caption.source) {
        extension_settings.caption.source = 'local';
    }

    if (extension_settings.caption.source === 'extras') {
        extension_settings.caption.source = 'local';
    }

    if (extension_settings.caption.source === 'openai') {
        extension_settings.caption.source = 'multimodal';
        extension_settings.caption.multimodal_api = 'openai';
        extension_settings.caption.multimodal_model = 'gpt-5.6-luna';
    }

    if (['google', 'vertexai'].includes(extension_settings.caption.multimodal_api)) {
        extension_settings.caption.multimodal_model = GOOGLE_MODEL_MIGRATIONS.get(extension_settings.caption.multimodal_model)
            ?? extension_settings.caption.multimodal_model;
    }

    if (!extension_settings.caption.multimodal_api) {
        extension_settings.caption.multimodal_api = 'openai';
    }

    if (!extension_settings.caption.multimodal_model) {
        extension_settings.caption.multimodal_model = 'gpt-5.6-luna';
    }

    if (initializePromptDefaults(extension_settings.caption, { prompt: PROMPT_DEFAULT })) {
        saveSettingsDebounced();
    }

    if (!extension_settings.caption.template) {
        extension_settings.caption.template = TEMPLATE_DEFAULT;
    }

    if (!extension_settings.caption.show_in_chat) {
        extension_settings.caption.show_in_chat = false;
    }
}

/**
 * Sets an image icon for the send button.
 */
async function setImageIcon() {
    try {
        const sendButton = $('#send_picture .extensionsMenuExtensionButton');
        sendButton.addClass('fa-image');
        sendButton.removeClass('fa-hourglass-half');
    } catch (error) {
        console.log(error);
    }
}

/**
 * Sets a spinner icon for the send button.
 */
async function setSpinnerIcon() {
    try {
        const sendButton = $('#send_picture .extensionsMenuExtensionButton');
        sendButton.removeClass('fa-image');
        sendButton.addClass('fa-hourglass-half');
    } catch (error) {
        console.log(error);
    }
}

/**
 * Wraps a caption with a message template.
 * @param {string} caption Raw caption
 * @returns {Promise<string>} Wrapped caption
 */
async function wrapCaptionTemplate(caption) {
    let template = extension_settings.caption.template || TEMPLATE_DEFAULT;

    if (!/{{caption}}/i.test(template)) {
        console.warn('Poka-yoke: Caption template does not contain {{caption}}. Appending it.');
        template += ' {{caption}}';
    }

    let messageText = substituteParams(template, { dynamicMacros: { caption: caption } });

    if (extension_settings.caption.refine_mode) {
        messageText = await Popup.show.input(
            'Review and edit the generated caption:',
            'Press "Cancel" to abort the caption sending.',
            messageText,
            { rows: 8, okButton: 'Send' });

        if (!messageText) {
            throw new Error('User aborted the caption sending.');
        }
    }

    return messageText;
}

/**
 * Sends a captioned message to the chat.
 * @param {string} caption Caption text
 * @param {string} image Image URL
 * @param {string} mimeType Image MIME type
 * @returns {Promise<void>}
 */
async function sendCaptionedMessage(caption, image, mimeType) {
    const messageText = await wrapCaptionTemplate(caption);

    const context = getContext();

    /** @type {MediaAttachment} */
    const mediaAttachment = {
        url: image,
        type: MEDIA_TYPE.getFromMime(mimeType) || MEDIA_TYPE.IMAGE,
        title: messageText,
        captioned: true,
        source: MEDIA_SOURCE.CAPTIONED,
    };
    /** @type {ChatMessage} */
    const message = {
        name: context.name1,
        is_user: true,
        send_date: getMessageTimeStamp(),
        mes: messageText,
        extra: {
            media: [mediaAttachment],
            media_display: MEDIA_DISPLAY.GALLERY,
            media_index: 0,
            inline_image: !!extension_settings.caption.show_in_chat,
        },
    };
    chat_metadata.tainted = true;
    context.chat.push(message);
    const messageId = context.chat.length - 1;
    await eventSource.emit(event_types.MESSAGE_SENT, messageId);
    context.addOneMessage(message);
    await eventSource.emit(event_types.USER_MESSAGE_RENDERED, messageId);
    await context.saveChat();
    setTimeout(() => context.scrollOnMediaLoad(), debounce_timeout.short);
}

/**
 * Generates a caption for an image using a selected source.
 * @param {string} base64Img Base64 encoded image without the data:image/...;base64, prefix
 * @param {string} fileData Base64 encoded image with the data:image/...;base64, prefix
 * @param {string} externalPrompt Caption prompt
 * @returns {Promise<{caption: string}>} Generated caption
 */
async function doCaptionRequest(base64Img, fileData, externalPrompt) {
    switch (extension_settings.caption.source) {
        case 'local':
            return await captionLocal(base64Img);
        case 'horde':
            return await captionHorde(base64Img);
        case 'multimodal':
            return await captionMultimodal(fileData, externalPrompt);
        default:
            throw new Error('Unknown caption source.');
    }
}

/**
 * Generates a caption for an image using a local model.
 * @param {string} base64Img Base64 encoded image without the data:image/...;base64, prefix
 * @returns {Promise<{caption: string}>} Generated caption
 */
async function captionLocal(base64Img) {
    const apiResult = await fetch('/api/extra/caption', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ image: base64Img }),
    });

    if (!apiResult.ok) {
        const body = await apiResult.json().catch(() => null);
        throw new Error(body?.error?.message || 'Failed to caption image via local pipeline.');
    }

    const data = await apiResult.json();
    return data;
}

/**
 * Generates a caption for an image using a Horde model.
 * @param {string} base64Img Base64 encoded image without the data:image/...;base64, prefix
 * @returns {Promise<{caption: string}>} Generated caption
 */
async function captionHorde(base64Img) {
    const apiResult = await fetch('/api/horde/caption-image', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ image: base64Img }),
    });

    if (!apiResult.ok) {
        throw new Error('Failed to caption image via Horde.');
    }

    const data = await apiResult.json();
    return data;
}

/**
 * Generates a caption for an image using a multimodal model.
 * @param {string} base64Img Base64 encoded image with the data:image/...;base64, prefix
 * @param {string} externalPrompt Caption prompt
 * @returns {Promise<{caption: string}>} Generated caption
 */
async function captionMultimodal(base64Img, externalPrompt) {
    let prompt = externalPrompt || extension_settings.caption.prompt;

    if (!externalPrompt && extension_settings.caption.prompt_ask) {
        const customPrompt = await callGenericPopup('Enter a comment or question:', POPUP_TYPE.INPUT, prompt, { rows: 4 });
        if (!customPrompt) {
            throw new Error('User aborted the caption sending.');
        }
        prompt = String(customPrompt).trim();
    }

    prompt = substituteParams(requireStoredPrompt(prompt, t`Fill in the prompt or reset it to the default.`));

    const caption = await getMultimodalCaption(base64Img, prompt);
    return { caption };
}

function onRefineModeInput() {
    extension_settings.caption.refine_mode = $('#caption_refine_mode').prop('checked');
    saveSettingsDebounced();
}

/**
 * Checks if video captioning is available for the current source.
 * @returns {boolean} True if video captioning is supported for the current source.
 */
function isVideoCaptioningAvailable() {
    if (extension_settings.caption.source !== 'multimodal') {
        return false;
    }

    return ['google', 'vertexai', 'zai'].includes(extension_settings.caption.multimodal_api);
}

export async function init() {
    function addSendPictureButton() {
        const sendButton = $(`
        <div id="send_picture" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-image extensionsMenuExtensionButton"></div>
            <span data-i18n="Generate Caption">Generate Caption</span>
        </div>`);

        $('#caption_wand_container').append(sendButton);
        $(sendButton).on('click', () => {
            const hasCaptionModule = (() => {
                const settings = extension_settings.caption;

                // Handle non-multimodal sources
                if (settings.source === 'local' || settings.source === 'horde') return true;

                // Handle multimodal sources
                if (settings.source === 'multimodal') {
                    const api = settings.multimodal_api;
                    const altEndpointEnabled = settings.alt_endpoint_enabled;
                    const altEndpointUrl = settings.alt_endpoint_url;

                    // APIs that support reverse proxy
                    const reverseProxyApis = {
                        'openai': SECRET_KEYS.OPENAI,
                        'mistral': SECRET_KEYS.MISTRALAI,
                        'google': SECRET_KEYS.MAKERSUITE,
                        'vertexai': SECRET_KEYS.VERTEXAI,
                        'anthropic': SECRET_KEYS.CLAUDE,
                        'xai': SECRET_KEYS.XAI,
                        'zai': SECRET_KEYS.ZAI,
                        'moonshot': SECRET_KEYS.MOONSHOT,
                    };

                    if (reverseProxyApis[api]) {
                        if (secret_state[reverseProxyApis[api]] || settings.allow_reverse_proxy) {
                            return true;
                        }
                    }

                    const chatCompletionApis = {
                        'openrouter': SECRET_KEYS.OPENROUTER,
                        'groq': SECRET_KEYS.GROQ,
                        'cohere': SECRET_KEYS.COHERE,
                        'aimlapi': SECRET_KEYS.AIMLAPI,
                        'nanogpt': SECRET_KEYS.NANOGPT,
                        'chutes': SECRET_KEYS.CHUTES,
                        'electronhub': SECRET_KEYS.ELECTRONHUB,
                        'pollinations': SECRET_KEYS.POLLINATIONS,
                        'workers_ai': SECRET_KEYS.WORKERS_AI,
                    };

                    if (chatCompletionApis[api] && secret_state[chatCompletionApis[api]]) {
                        return true;
                    }

                    const textCompletionApis = {
                        'ollama': textgen_types.OLLAMA,
                        'llamacpp': textgen_types.LLAMACPP,
                        'ooba': textgen_types.OOBA,
                        'koboldcpp': textgen_types.KOBOLDCPP,
                        'vllm': textgen_types.VLLM,
                    };

                    if (textCompletionApis[api] && altEndpointEnabled && altEndpointUrl) {
                        return true;
                    }

                    if (textCompletionApis[api] && !altEndpointEnabled && textgenerationwebui_settings.server_urls[textCompletionApis[api]]) {
                        return true;
                    }

                    // Custom API and anonymous Pollinations don't need additional checks
                    if (api === 'custom' || (api === 'pollinations' && oai_settings.pollinations_endpoint === POLLINATIONS_ENDPOINT.ANONYMOUS)) {
                        return true;
                    }
                }

                return false;
            })();

            if (!hasCaptionModule) {
                toastr.error('Choose other captioning source in the extension settings.', 'Captioning is not available');
                return;
            }

            $('#img_file').trigger('click');
        });
    }
    function addPictureSendForm() {
        const imgInput = document.createElement('input');
        imgInput.type = 'file';
        imgInput.id = 'img_file';
        imgInput.accept = 'image/*,video/*';
        imgInput.hidden = true;
        imgInput.addEventListener('change', (e) => handleWandFileChange(e));
        const imgForm = document.createElement('form');
        imgForm.id = 'img_form';
        imgForm.appendChild(imgInput);
        imgForm.hidden = true;
        $('#form_sheld').append(imgForm);
    }
    async function switchMultimodalBlocks() {
        await addRemoteEndpointModels();
        const isMultimodal = extension_settings.caption.source === 'multimodal';
        if (!extension_settings.caption.multimodal_model) {
            const dropdown = $('#caption_multimodal_model');
            const options = dropdown.find(`option[data-type="${extension_settings.caption.multimodal_api}"]`);
            extension_settings.caption.multimodal_model = String(options.first().val());
        }
        $('#caption_multimodal_block').toggle(isMultimodal);
        $('#caption_prompt_block').toggle(isMultimodal);
        $('#caption_multimodal_api').val(extension_settings.caption.multimodal_api);
        $('#caption_multimodal_model').val(extension_settings.caption.multimodal_model);
        $('#caption_multimodal_block [data-type]').each(function () {
            const type = $(this).data('type');
            const types = type.split(',');
            $(this).toggle(types.includes(extension_settings.caption.multimodal_api));
        });
        refreshCaptionBehaviorSummary();
    }
    async function addSettings() {
        const html = await renderExtensionTemplateAsync('caption', 'settings', { TEMPLATE_DEFAULT, PROMPT_DEFAULT });
        $('#caption_container').append(html);
    }

    async function addRemoteEndpointModels() {
        async function processEndpoint(api, url, additionalParams = {}) {
            const dropdown = document.getElementById('caption_multimodal_model');
            if (!(dropdown instanceof HTMLSelectElement)) {
                return;
            }
            if (extension_settings.caption.source !== 'multimodal' || extension_settings.caption.multimodal_api !== api) {
                return;
            }
            const options = Array.from(dropdown.options);
            const response = await fetch(url, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(additionalParams),
            });
            if (!response.ok) {
                return;
            }
            const modelIds = await response.json();
            if (Array.isArray(modelIds) && modelIds.length > 0) {
                modelIds.sort().forEach((modelId) => {
                    if (!modelId || typeof modelId !== 'string' || options.some(o => o.value === modelId && o.dataset.type === api)) {
                        return;
                    }
                    const option = document.createElement('option');
                    option.value = modelId;
                    option.textContent = modelId;
                    option.dataset.type = api;
                    dropdown.add(option);
                });
            }
        }

        await processEndpoint('openrouter', '/api/openrouter/models/multimodal');
        await processEndpoint('aimlapi', '/api/backends/chat-completions/multimodal-models/aimlapi');
        await processEndpoint('pollinations', '/api/backends/chat-completions/multimodal-models/pollinations');
        await processEndpoint('nanogpt', '/api/backends/chat-completions/multimodal-models/nanogpt');
        await processEndpoint('chutes', '/api/backends/chat-completions/multimodal-models/chutes');
        await processEndpoint('electronhub', '/api/backends/chat-completions/multimodal-models/electronhub');
        await processEndpoint('mistral', '/api/backends/chat-completions/multimodal-models/mistral');
        await processEndpoint('xai', '/api/backends/chat-completions/multimodal-models/xai');
        await processEndpoint('moonshot', '/api/backends/chat-completions/multimodal-models/moonshot');
        await processEndpoint('workers_ai', '/api/backends/chat-completions/multimodal-models/workers_ai', { workers_ai_account_id: oai_settings.workers_ai_account_id });
    }

    await addSettings();
    addPictureSendForm();
    addSendPictureButton();
    setImageIcon();
    migrateSettings();
    await switchMultimodalBlocks();

    $('#caption_refine_mode').prop('checked', !!(extension_settings.caption.refine_mode));
    $('#caption_allow_reverse_proxy').prop('checked', !!(extension_settings.caption.allow_reverse_proxy));
    $('#caption_prompt_ask').prop('checked', !!(extension_settings.caption.prompt_ask));
    $('#caption_auto_mode').prop('checked', !!(extension_settings.caption.auto_mode));
    $('#caption_source').val(extension_settings.caption.source);
    $('#caption_prompt').val(extension_settings.caption.prompt);
    $('#caption_template').val(extension_settings.caption.template);
    $('#caption_refine_mode').on('input', onRefineModeInput);
    $('#caption_source').on('change', async () => {
        extension_settings.caption.source = String($('#caption_source').val());
        await switchMultimodalBlocks();
        saveSettingsDebounced();
    });
    $('#caption_prompt').on('input', () => {
        extension_settings.caption.prompt = String($('#caption_prompt').val());
        saveSettingsDebounced();
    });
    $('#caption_prompt_restore').on('click', () => {
        extension_settings.caption.prompt = PROMPT_DEFAULT;
        $('#caption_prompt').val(PROMPT_DEFAULT);
        saveSettingsDebounced();
        refreshCaptionBehaviorSummary();
    });
    $('#caption_template').on('input', () => {
        extension_settings.caption.template = String($('#caption_template').val());
        saveSettingsDebounced();
    });
    $('#caption_allow_reverse_proxy').on('input', () => {
        extension_settings.caption.allow_reverse_proxy = $('#caption_allow_reverse_proxy').prop('checked');
        saveSettingsDebounced();
    });
    $('#caption_prompt_ask').on('input', () => {
        extension_settings.caption.prompt_ask = $('#caption_prompt_ask').prop('checked');
        saveSettingsDebounced();
    });
    $('#caption_auto_mode').on('input', () => {
        extension_settings.caption.auto_mode = !!$('#caption_auto_mode').prop('checked');
        saveSettingsDebounced();
    });
    $('#caption_ollama_pull').on('click', (e) => {
        const selectedModel = extension_settings.caption.multimodal_model;
        const staticModels = { 'ollama_current': textgenerationwebui_settings.ollama_model, 'ollama_custom': extension_settings.caption.ollama_custom_model };
        const presetModel = staticModels[selectedModel] || selectedModel;
        e.preventDefault();
        $('#ollama_download_model').trigger('click');
        $('.popup .popup-input').val(presetModel);
    });
    $('#caption_multimodal_api').on('change', async () => {
        const api = String($('#caption_multimodal_api').val());
        extension_settings.caption.multimodal_api = api;
        extension_settings.caption.multimodal_model = '';
        await switchMultimodalBlocks();
        saveSettingsDebounced();
    });
    $('#caption_multimodal_model').on('change', () => {
        extension_settings.caption.multimodal_model = String($('#caption_multimodal_model').val());
        saveSettingsDebounced();
    });
    $('#caption_altEndpoint_url').val(extension_settings.caption.alt_endpoint_url).on('input', () => {
        extension_settings.caption.alt_endpoint_url = String($('#caption_altEndpoint_url').val());
        saveSettingsDebounced();
    });
    $('#caption_altEndpoint_enabled').prop('checked', !!(extension_settings.caption.alt_endpoint_enabled)).on('input', () => {
        extension_settings.caption.alt_endpoint_enabled = !!$('#caption_altEndpoint_enabled').prop('checked');
        saveSettingsDebounced();
    });
    $('#caption_show_in_chat').prop('checked', !!(extension_settings.caption.show_in_chat)).on('input', () => {
        extension_settings.caption.show_in_chat = !!$('#caption_show_in_chat').prop('checked');
        saveSettingsDebounced();
    });
    $('#caption_ollama_custom_model').val(extension_settings.caption.ollama_custom_model || '').on('input', () => {
        extension_settings.caption.ollama_custom_model = String($('#caption_ollama_custom_model').val()).trim();
        saveSettingsDebounced();
    });
    $('#caption_custom_model').val(extension_settings.caption.custom_model || '').on('input', () => {
        extension_settings.caption.custom_model = String($('#caption_custom_model').val()).trim();
        saveSettingsDebounced();
    });
    $('#caption_refresh_models').on('click', async () => {
        extension_settings.caption.multimodal_model = '';
        await switchMultimodalBlocks();
        saveSettingsDebounced();
    });

    mountCaptionBehaviorSummary();
    if (event_types?.APP_READY) {
        eventSource.on(event_types.APP_READY, refreshCaptionBehaviorSummary);
    }

    const onMessageEvent = async (/** @type {number} */ messageId) => {
        if (!extension_settings.caption.auto_mode) {
            return;
        }

        const message = getContext().chat[messageId];
        if (Array.isArray(message?.extra?.media) && message.extra.media.length > 0) {
            for (let mediaIndex = 0; mediaIndex < message.extra.media.length; mediaIndex++) {
                const mediaAttachment = message.extra.media[mediaIndex];
                if (mediaAttachment.type === MEDIA_TYPE.VIDEO && !isVideoCaptioningAvailable()) {
                    continue;
                }
                if (mediaAttachment.type === MEDIA_TYPE.AUDIO) {
                    continue;
                }
                // Skip already captioned images and non-uploaded (generated, etc.) images
                if (mediaAttachment.source !== MEDIA_SOURCE.UPLOAD || mediaAttachment.captioned) {
                    continue;
                }
                try {
                    await captionExistingMessage(message, mediaIndex);
                } catch (e) {
                    console.error(`Auto-captioning failed for message ID ${messageId}, media index ${mediaIndex}`, e);
                    continue;
                }
            }
        }
    };

    eventSource.on(event_types.MESSAGE_SENT, onMessageEvent);
    eventSource.on(event_types.MESSAGE_FILE_EMBEDDED, onMessageEvent);

    $(document).on('click', '.mes_img_caption', async function () {
        const animationClass = 'fa-fade';
        const messageBlock = $(this).closest('.mes');
        const mediaContainer = $(this).closest('.mes_media_container');
        const messageMedia = mediaContainer.find('.mes_img, .mes_video');
        if (messageMedia.hasClass(animationClass)) return;
        messageMedia.addClass(animationClass);
        try {
            const messageId = Number(messageBlock.attr('mesid'));
            const mediaIndex = Number(mediaContainer.attr('data-index'));
            const data = getContext().chat[messageId];
            await captionExistingMessage(data, mediaIndex);
            appendMediaToMessage(data, messageBlock, SCROLL_BEHAVIOR.KEEP);
            await saveChatConditional();
        } catch (e) {
            console.error('Message image recaption failed', e);
            toastr.error(e.message || 'Unknown error', 'Failed to caption');
        } finally {
            messageMedia.removeClass(animationClass);
        }
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'caption',
        callback: captionCommandCallback,
        returns: 'caption',
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'quiet', 'suppress sending a captioned message', [ARGUMENT_TYPE.BOOLEAN], false, false, 'false',
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'mesId',
                description: 'get image from a message with this ID',
                typeList: [ARGUMENT_TYPE.NUMBER],
                enumProvider: commonEnumProviders.messages(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'index',
                description: 'index of the image in the message to caption (starting from 0)',
                typeList: [ARGUMENT_TYPE.NUMBER],
                enumProvider: commonEnumProviders.messageMedia(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'prompt', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: `
            <div>
                Caption an image with an optional prompt and passes the caption down the pipe.
            </div>
            <div>
                Only multimodal sources support custom prompts.
            </div>
            <div>
                Provide a message ID to get an image from a message instead of uploading one.
            </div>
            <div>
                Set the "quiet" argument to true to suppress sending a captioned message, default: false.
            </div>
        `,
    }));

    document.body.classList.add('caption');
}
