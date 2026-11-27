export { translate };

import {
    eventSource,
    event_types,
    getRequestHeaders,
    reloadCurrentChat,
    saveSettingsDebounced,
    substituteParams,
    updateMessageBlock,
} from '../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { POPUP_TYPE, callGenericPopup } from '../../popup.js';
import { updateReasoningUI } from '../../reasoning.js';
import { secret_state } from '../../secrets.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { enumIcons } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { enumTypes, SlashCommandEnumValue } from '../../slash-commands/SlashCommandEnumValue.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { splitRecursive } from '../../utils.js';
import { t } from '../../i18n.js';
import { mountBehaviorSummary } from '../../lens-shared/behavior-summary.js';
import { buildTranslateSummaryModel } from './behavior-summary-model.js';
import { autoModeOptions, createTranslateController } from './translate-controller.js';

let translateSummaryHandle = null;

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

function refreshTranslateBehaviorSummary() {
    translateSummaryHandle?.refresh();
}

function mountTranslateBehaviorSummary() {
    translateSummaryHandle?.destroy();
    translateSummaryHandle = null;

    const container = document.getElementById('translation_container') || document;
    const drawerContent = container.querySelector('.translation_settings .inline-drawer-content');
    if (!drawerContent) {
        return null;
    }

    translateSummaryHandle = mountBehaviorSummary({
        id: 'translate-settings',
        root: drawerContent,
        anchor: drawerContent,
        position: 'prepend',
        ariaLabel: translateSummary('Chat translation behavior summary'),
        fields: {
            autoMode: '#translation_auto_mode',
            provider: '#translation_provider',
            deeplEndpoint: '#deepl_api_endpoint',
            keyButton: '#translate_key_button',
            urlButton: '#translate_url_button',
            targetLanguage: '#translation_target_language',
        },
        readState: (rootEl) => {
            const autoSel = /** @type {HTMLSelectElement|null} */ (rootEl.querySelector('#translation_auto_mode'));
            const providerSel = /** @type {HTMLSelectElement|null} */ (rootEl.querySelector('#translation_provider'));
            const langSel = /** @type {HTMLSelectElement|null} */ (rootEl.querySelector('#translation_target_language'));
            const deeplSel = /** @type {HTMLSelectElement|null} */ (rootEl.querySelector('#deepl_api_endpoint'));
            const provider = String(providerSel?.value || extension_settings.translate?.provider || 'google').trim();
            return {
                autoMode: String(autoSel?.value || extension_settings.translate?.auto_mode || 'none').trim(),
                provider,
                providerLabel: readSelectDisplayLabel(providerSel),
                deeplEndpoint: String(deeplSel?.value || extension_settings.translate?.deepl_endpoint || 'free').trim(),
                targetLanguage: String(langSel?.value || extension_settings.translate?.target_language || 'en').trim(),
                targetLanguageLabel: readSelectDisplayLabel(langSel),
                hasKey: Boolean(secret_state[provider]),
                hasUrl: Boolean(secret_state[`${provider}_url`]),
                i18n: translateSummary,
            };
        },
        build: buildTranslateSummaryModel,
    });

    return translateSummaryHandle;
}

export { autoModeOptions };

const {
    translate,
    translateIncomingMessage,
    translateIncomingMessageReasoning,
    handleIncomingMessage,
    handleOutgoingMessage,
    handleImpersonateReady,
    handleMessageEdited,
    handleMessageUpdate,
    handleMessageReasoningEdit,
    handleMessageReasoningDelete,
    clearRecentlyEditedMessages,
} = createTranslateController({
    getSettings: () => extension_settings.translate,
    getContext: (...args) => getContext(...args),
    getRequestHeaders: (...args) => getRequestHeaders(...args),
    getSecretState: () => secret_state,
    substituteParams: (...args) => substituteParams(...args),
    updateMessageBlock: (...args) => updateMessageBlock(...args),
    updateReasoningUI: (...args) => updateReasoningUI(...args),
    splitRecursive: (...args) => splitRecursive(...args),
    t: (...args) => t(...args),
});

const defaultSettings = {
    target_language: 'en',
    internal_language: 'en',
    provider: 'google',
    auto_mode: autoModeOptions.NONE,
    deepl_endpoint: 'free',
};

const languageCodes = {
    'Afrikaans': 'af',
    'Albanian': 'sq',
    'Amharic': 'am',
    'Arabic': 'ar',
    'Armenian': 'hy',
    'Azerbaijani': 'az',
    'Basque': 'eu',
    'Belarusian': 'be',
    'Bengali': 'bn',
    'Bosnian': 'bs',
    'Bulgarian': 'bg',
    'Catalan': 'ca',
    'Cebuano': 'ceb',
    'Chinese (Simplified)': 'zh-CN',
    'Chinese (Traditional)': 'zh-TW',
    'Corsican': 'co',
    'Croatian': 'hr',
    'Czech': 'cs',
    'Danish': 'da',
    'Dutch': 'nl',
    'English': 'en',
    'Esperanto': 'eo',
    'Estonian': 'et',
    'Finnish': 'fi',
    'French': 'fr',
    'Frisian': 'fy',
    'Galician': 'gl',
    'Georgian': 'ka',
    'German': 'de',
    'Greek': 'el',
    'Gujarati': 'gu',
    'Haitian Creole': 'ht',
    'Hausa': 'ha',
    'Hawaiian': 'haw',
    'Hebrew': 'iw',
    'Hindi': 'hi',
    'Hmong': 'hmn',
    'Hungarian': 'hu',
    'Icelandic': 'is',
    'Igbo': 'ig',
    'Indonesian': 'id',
    'Irish': 'ga',
    'Italian': 'it',
    'Japanese': 'ja',
    'Javanese': 'jw',
    'Kannada': 'kn',
    'Kazakh': 'kk',
    'Khmer': 'km',
    'Korean': 'ko',
    'Kurdish': 'ku',
    'Kyrgyz': 'ky',
    'Lao': 'lo',
    'Latin': 'la',
    'Latvian': 'lv',
    'Lithuanian': 'lt',
    'Luxembourgish': 'lb',
    'Macedonian': 'mk',
    'Malagasy': 'mg',
    'Malay': 'ms',
    'Malayalam': 'ml',
    'Maltese': 'mt',
    'Maori': 'mi',
    'Marathi': 'mr',
    'Mongolian': 'mn',
    'Myanmar (Burmese)': 'my',
    'Nepali': 'ne',
    'Norwegian': 'no',
    'Nyanja (Chichewa)': 'ny',
    'Pashto': 'ps',
    'Persian': 'fa',
    'Polish': 'pl',
    'Portuguese (Portugal)': 'pt-PT',
    'Portuguese (Brazil)': 'pt-BR',
    'Punjabi': 'pa',
    'Romanian': 'ro',
    'Russian': 'ru',
    'Samoan': 'sm',
    'Scots Gaelic': 'gd',
    'Serbian': 'sr',
    'Sesotho': 'st',
    'Shona': 'sn',
    'Sindhi': 'sd',
    'Sinhala (Sinhalese)': 'si',
    'Slovak': 'sk',
    'Slovenian': 'sl',
    'Somali': 'so',
    'Spanish': 'es',
    'Sundanese': 'su',
    'Swahili': 'sw',
    'Swedish': 'sv',
    'Tagalog (Filipino)': 'tl',
    'Tajik': 'tg',
    'Tamil': 'ta',
    'Telugu': 'te',
    'Thai': 'th',
    'Turkish': 'tr',
    'Ukrainian': 'uk',
    'Urdu': 'ur',
    'Uzbek': 'uz',
    'Vietnamese': 'vi',
    'Welsh': 'cy',
    'Xhosa': 'xh',
    'Yiddish': 'yi',
    'Yoruba': 'yo',
    'Zulu': 'zu',
};

const KEY_REQUIRED = ['deepl', 'libre'];
const LOCAL_URL = ['libre', 'oneringtranslator', 'deeplx', 'lingva'];

function showKeysButton() {
    const providerRequiresKey = KEY_REQUIRED.includes(extension_settings.translate.provider);
    const providerOptionalUrl = LOCAL_URL.includes(extension_settings.translate.provider);
    $('#translate_key_button').toggle(providerRequiresKey).data('key', extension_settings.translate.provider);
    $('#translate_key_button').toggleClass('success', Boolean(secret_state[extension_settings.translate.provider]));
    $('#translate_url_button').toggle(providerOptionalUrl).data('key', extension_settings.translate.provider + '_url');
    $('#translate_url_button').toggleClass('success', Boolean(secret_state[extension_settings.translate.provider + '_url']));
    $('#deepl_api_endpoint').toggle(extension_settings.translate.provider === 'deepl');
}

function loadSettings() {
    for (const key in defaultSettings) {
        if (!Object.hasOwn(extension_settings.translate, key)) {
            extension_settings.translate[key] = defaultSettings[key];
        }
    }

    $(`#translation_provider option[value="${extension_settings.translate.provider}"]`).attr('selected', 'true');
    $(`#translation_target_language option[value="${extension_settings.translate.target_language}"]`).attr('selected', 'true');
    $(`#translation_auto_mode option[value="${extension_settings.translate.auto_mode}"]`).attr('selected', 'true');
    $('#deepl_api_endpoint').val(extension_settings.translate.deepl_endpoint).toggle(extension_settings.translate.provider === 'deepl');
    showKeysButton();
    refreshTranslateBehaviorSummary();
}

async function onTranslateInputMessageClick() {
    const textarea = document.getElementById('send_textarea');

    if (!(textarea instanceof HTMLTextAreaElement)) {
        return;
    }

    if (!textarea.value) {
        toastr.warning('Enter a message first');
        return;
    }

    const toast = toastr.info('Input Message is translating', 'Please wait...');
    const translatedText = await translate(textarea.value, extension_settings.translate.internal_language);
    textarea.value = translatedText;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    toastr.clear(toast);
}

// Prevents the chat from being translated in parallel
let translateChatExecuting = false;

async function onTranslateChatClick() {
    if (translateChatExecuting) {
        return;
    }

    try {
        translateChatExecuting = true;
        const context = getContext();
        const chat = context.chat;

        toastr.info(`${chat.length} message(s) queued for translation.`, 'Please wait...');

        for (let i = 0; i < chat.length; i++) {
            await translateIncomingMessageReasoning(i);
            await translateIncomingMessage(i);
        }

        await context.saveChat();
    } catch (error) {
        console.log(error);
        toastr.error('Failed to translate chat');
    } finally {
        translateChatExecuting = false;
    }
}

async function onTranslationsClearClick() {
    const popupHtml = await renderExtensionTemplateAsync('translate', 'deleteConfirmation');
    const confirm = await callGenericPopup(popupHtml, POPUP_TYPE.CONFIRM);

    if (!confirm) {
        return;
    }

    const context = getContext();
    const chat = context.chat;

    for (const mes of chat) {
        if (mes.extra) {
            delete mes.extra.display_text;
            delete mes.extra.reasoning_display_text;
        }
    }

    await context.saveChat();
    await reloadCurrentChat();
}

async function onMessageTranslateClick() {
    const context = getContext();
    const messageId = $(this).closest('.mes').attr('mesid');
    const message = context.chat[messageId];

    // If the message is already translated, revert it back to the original text
    let alreadyTranslated = false;
    if (message?.extra?.display_text) {
        delete message.extra.display_text;
        updateMessageBlock(Number(messageId), message);
        alreadyTranslated = true;
    }
    if (message?.extra?.reasoning_display_text) {
        delete message.extra.reasoning_display_text;
        updateReasoningUI(Number(messageId));
        alreadyTranslated = true;
    }

    // If the message is not translated, translate it
    if (!alreadyTranslated) {
        await translateIncomingMessageReasoning(messageId);
        await translateIncomingMessage(messageId);
    }

    await context.saveChat();
}

globalThis.translate = translate;

export async function init() {
    const html = await renderExtensionTemplateAsync('translate', 'index');
    const buttonHtml = await renderExtensionTemplateAsync('translate', 'buttons');

    $('#translate_wand_container').append(buttonHtml);
    $('#translation_container').append(html);
    $('#translate_chat').on('click', onTranslateChatClick);
    $('#translate_input_message').on('click', onTranslateInputMessageClick);
    $('#translation_clear').on('click', onTranslationsClearClick);

    for (const [key, value] of Object.entries(languageCodes)) {
        $('#translation_target_language').append(`<option value="${value}">${key}</option>`);
    }

    $('#translation_auto_mode').on('change', (event) => {
        if (!(event.target instanceof HTMLSelectElement)) {
            return;
        }
        extension_settings.translate.auto_mode = event.target.value;
        saveSettingsDebounced();
    });
    $('#translation_provider').on('change', (event) => {
        if (!(event.target instanceof HTMLSelectElement)) {
            return;
        }
        extension_settings.translate.provider = event.target.value;
        showKeysButton();
        saveSettingsDebounced();
    });
    $('#translation_target_language').on('change', (event) => {
        if (!(event.target instanceof HTMLSelectElement)) {
            return;
        }
        extension_settings.translate.target_language = event.target.value;
        saveSettingsDebounced();
    });
    $('#deepl_api_endpoint').on('change', (event) => {
        if (!(event.target instanceof HTMLSelectElement)) {
            return;
        }
        extension_settings.translate.deepl_endpoint = event.target.value;
        saveSettingsDebounced();
    });
    $(document).on('click', '.mes_translate', onMessageTranslateClick);

    [event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SECRET_ROTATED].forEach((eventType) => {
        eventSource.on(eventType, (/** @type {string} */ key) => {
            if (key === extension_settings.translate.provider) {
                $('#translate_key_button').toggleClass('success', !!secret_state[extension_settings.translate.provider]);
            }
            if (key === `${extension_settings.translate.provider}_url`) {
                $('#translate_url_button').toggleClass('success', !!secret_state[`${extension_settings.translate.provider}_url`]);
            }
            refreshTranslateBehaviorSummary();
        });
    });

    loadSettings();
    mountTranslateBehaviorSummary();
    if (event_types?.APP_READY) {
        eventSource.on(event_types.APP_READY, refreshTranslateBehaviorSummary);
    }

    eventSource.makeFirst(event_types.CHARACTER_MESSAGE_RENDERED, handleIncomingMessage);
    eventSource.makeFirst(event_types.USER_MESSAGE_RENDERED, handleOutgoingMessage);
    eventSource.on(event_types.MESSAGE_SWIPED, handleIncomingMessage);
    eventSource.on(event_types.IMPERSONATE_READY, handleImpersonateReady);
    eventSource.on(event_types.MESSAGE_EDITED, handleMessageEdited);
    eventSource.on(event_types.MESSAGE_UPDATED, handleMessageUpdate);
    eventSource.on(event_types.MESSAGE_REASONING_EDITED, handleMessageReasoningEdit);
    eventSource.on(event_types.MESSAGE_REASONING_DELETED, handleMessageReasoningDelete);
    eventSource.on(event_types.CHAT_CHANGED, () => clearRecentlyEditedMessages());

    document.body.classList.add('translate');

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'translate',
        helpString: 'Translate text to a target language. If target language is not provided, the value from the extension settings will be used.',
        namedArgumentList: [
            new SlashCommandNamedArgument('target', 'The target language code to translate to', ARGUMENT_TYPE.STRING, false, false, '', Object.values(languageCodes)),
            SlashCommandNamedArgument.fromProps({
                name: 'provider',
                description: 'The translation provider to use. If not provided, the value from the extension settings will be used.',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
                enumProvider: () => Array.from(document.getElementById('translation_provider').querySelectorAll('option')).map((option) => new SlashCommandEnumValue(option.value, option.text, enumTypes.name, enumIcons.server)),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('The text to translate', ARGUMENT_TYPE.STRING, true, false, ''),
        ],
        callback: async (args, value) => {
            const target = args?.target && Object.values(languageCodes).includes(String(args.target))
                ? String(args.target)
                : extension_settings.translate.target_language;
            const provider = args?.provider || extension_settings.translate.provider;
            return await translate(String(value), target, provider);
        },
        returns: ARGUMENT_TYPE.STRING,
    }));
}
