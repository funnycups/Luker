import { cancelTtsPlay, eventSource, event_types, getCurrentChatId, isStreamingEnabled, name2, saveSettingsDebounced, substituteParams } from '../../../script.js';
import { ModuleWorkerWrapper, extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { delay, escapeRegex, getBase64Async, getStringHash, onlyUnique, regexFromString } from '../../utils.js';
import { accountStorage } from '../../util/AccountStorage.js';
import { EdgeTtsProvider } from './edge.js';
import { ElevenLabsTtsProvider } from './elevenlabs.js';
import { SileroTtsProvider } from './silerotts.js';
import { GptSovitsV2Provider } from './gpt-sovits-v2.js';
import { GptSoVITSAdapterProvider } from './gpt-sovits-adapter.js';
import { SystemTtsProvider } from './system.js';
import { NovelTtsProvider } from './novel.js';
import { power_user } from '../../power-user.js';
import { OpenAITtsProvider } from './openai.js';
import { OpenAICompatibleTtsProvider } from './openai-compatible.js';
import { XTTSTtsProvider } from './xtts.js';
import { VITSTtsProvider } from './vits.js';
import { GSVITtsProvider } from './gsvi.js';
import { SBVits2TtsProvider } from './sbvits2.js';
import { AllTalkTtsProvider } from './alltalk.js';
import { CosyVoiceProvider } from './cosyvoice.js';
import { SpeechT5TtsProvider } from './speecht5.js';
import { AzureTtsProvider } from './azure.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { debounce_timeout } from '../../constants.js';
import { SlashCommandEnumValue, enumTypes } from '../../slash-commands/SlashCommandEnumValue.js';
import { enumIcons } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { POPUP_TYPE, Popup, callGenericPopup } from '../../popup.js';
import { GoogleTranslateTtsProvider } from './google-translate.js';
import { GoogleNativeTtsProvider } from './google-native.js';
import { ChatterboxTtsProvider } from './chatterbox.js';
import { KokoroTtsProvider } from './kokoro.js';
import { TtsWebuiProvider } from './tts-webui.js';
import { PollinationsTtsProvider } from './pollinations.js';
import { MiniMaxTtsProvider } from './minimax.js';
import { ElectronHubTtsProvider } from './electronhub.js';
import { ChutesTtsProvider } from './chutes.js';
import { VolcengineTtsProvider } from './volcengine.js';
import { applyLocale, t, translate } from '/scripts/i18n.js';
import { renderTtsAttributionSelectors, loadAttributionMap, readAttributionFor, parseAndCacheAttribution, decorateMessageWithPlayButtons, ensureNpcVoiceMapEntries } from './npc-attribution.js';
import { extractQuoteSegments, attachQuoteIndices } from './quote-segments.js';

const UPDATE_INTERVAL = 1000;
const wrapper = new ModuleWorkerWrapper(moduleWorker);

let voiceMapEntries = [];
let voiceMap = {}; // {charName:voiceid, charName2:voiceid2}
let lastChatId = null;
let lastMessage = null;
let lastMessageHash = null;
let periodicMessageGenerationTimer = null;
let lastPositionOfParagraphEnd = -1;
let currentInitVoiceMapPromise = null;

const DEFAULT_VOICE_MARKER = '[Default Voice]';
const DISABLED_VOICE_MARKER = 'disabled';
const SYSTEM_VOICE_ALIASES = new Set(['Luker System', 'SillyTavern System']);

export function isSystemVoiceAlias(name) {
    return SYSTEM_VOICE_ALIASES.has(name);
}

export function getPreviewString(lang) {
    const previewStrings = {
        'en-US': 'The quick brown fox jumps over the lazy dog',
        'en-GB': 'Sphinx of black quartz, judge my vow',
        'fr-FR': 'Portez ce vieux whisky au juge blond qui fume',
        'de-DE': 'Victor jagt zwölf Boxkämpfer quer über den großen Sylter Deich',
        'it-IT': 'Pranzo d\'acqua fa volti sghembi',
        'es-ES': 'Quiere la boca exhausta vid, kiwi, piña y fugaz jamón',
        'es-MX': 'Fabio me exige, sin tapujos, que añada cerveza al whisky',
        'ru-RU': 'В чащах юга жил бы цитрус? Да, но фальшивый экземпляр!',
        'pt-BR': 'Vejo xá gritando que fez show sem playback.',
        'pt-PR': 'Todo pajé vulgar faz boquinha sexy com kiwi.',
        'uk-UA': 'Фабрикуймо гідність, лящім їжею, ґав хапаймо, з\'єднавці чаш!',
        'pl-PL': 'Pchnąć w tę łódź jeża lub ośm skrzyń fig',
        'cs-CZ': 'Příliš žluťoučký kůň úpěl ďábelské ódy',
        'sk-SK': 'Vyhŕňme si rukávy a vyprážajme čínske ryžové cestoviny',
        'hu-HU': 'Árvíztűrő tükörfúrógép',
        'tr-TR': 'Pijamalı hasta yağız şoföre çabucak güvendi',
        'nl-NL': 'De waard heeft een kalfje en een pinkje opgegeten',
        'sv-SE': 'Yxskaftbud, ge vårbygd, zinkqvarn',
        'da-DK': 'Quizdeltagerne spiste jordbær med fløde, mens cirkusklovnen Walther spillede på xylofon',
        'ja-JP': 'いろはにほへと　ちりぬるを　わかよたれそ　つねならむ　うゐのおくやま　けふこえて　あさきゆめみし　ゑひもせす',
        'ko-KR': '가나다라마바사아자차카타파하',
        'zh-CN': '我能吞下玻璃而不伤身体',
        'ro-RO': 'Muzicologă în bej vând whisky și tequila, preț fix',
        'bg-BG': 'Щъркелите се разпръснаха по цялото небе',
        'el-GR': 'Ταχίστη αλώπηξ βαφής ψημένη γη, δρασκελίζει υπέρ νωθρού κυνός',
        'fi-FI': 'Voi veljet, miksi juuri teille myin nämä vehkeet?',
        'he-IL': 'הקצינים צעקו: "כל הכבוד לצבא הצבאות!"',
        'id-ID': 'Jangkrik itu memang enak, apalagi kalau digoreng',
        'ms-MY': 'Muzik penyanyi wanita itu menggambarkan kehidupan yang penuh dengan duka nestapa',
        'th-TH': 'เป็นไงบ้างครับ ผมชอบกินข้าวผัดกระเพราหมูกรอบ',
        'vi-VN': 'Cô bé quàng khăn đỏ đang ngồi trên bãi cỏ xanh',
        'ar-SA': 'أَبْجَدِيَّة عَرَبِيَّة',
        'hi-IN': 'श्वेता ने श्वेता के श्वेते हाथों में श्वेता का श्वेता चावल पकड़ा',
    };
    const fallbackPreview = 'Neque porro quisquam est qui dolorem ipsum quia dolor sit amet';

    return previewStrings[lang] ?? fallbackPreview;
}

/**
 * Registers a TTS provider.
 * @param {string} name Name of the TTS provider to register.
 * @param {function} provider Provider class.
 */
export function registerTtsProvider(name, provider) {
    if (!name || typeof name !== 'string') {
        throw new Error(`TTS provider name ${name} is not a valid string.`);
    }
    if (!provider || typeof provider !== 'function') {
        throw new Error(`TTS provider ${name} is not a valid provider class.`);
    }
    if (ttsProviders[name]) {
        throw new Error(`TTS provider ${name} is already registered.`);
    }
    ttsProviders[name] = provider;
    console.info(`Registered TTS provider: ${name}`);
    $('#tts_provider').append($('<option />').val(name).text(name));

    // Load if it was previously selected
    if (extension_settings.tts.currentProvider === name) {
        loadTtsProvider(name);
    }
}

const ttsProviders = {
    AllTalk: AllTalkTtsProvider,
    Azure: AzureTtsProvider,
    Chatterbox: ChatterboxTtsProvider,
    Chutes: ChutesTtsProvider,
    'CosyVoice (Unofficial)': CosyVoiceProvider,
    Edge: EdgeTtsProvider,
    ElevenLabs: ElevenLabsTtsProvider,
    'Electron Hub': ElectronHubTtsProvider,
    'Google Translate': GoogleTranslateTtsProvider,
    'Google Gemini TTS': GoogleNativeTtsProvider,
    GSVI: GSVITtsProvider,
    'GPT-SoVITS-Adapter': GptSoVITSAdapterProvider,
    'GPT-SoVITS-V2 (Unofficial)': GptSovitsV2Provider,
    Kokoro: KokoroTtsProvider,
    MiniMax: MiniMaxTtsProvider,
    Novel: NovelTtsProvider,
    OpenAI: OpenAITtsProvider,
    'OpenAI Compatible': OpenAICompatibleTtsProvider,
    Pollinations: PollinationsTtsProvider,
    SBVits2: SBVits2TtsProvider,
    Silero: SileroTtsProvider,
    SpeechT5: SpeechT5TtsProvider,
    System: SystemTtsProvider,
    'TTS WebUI': TtsWebuiProvider,
    VITS: VITSTtsProvider,
    XTTSv2: XTTSTtsProvider,
    Volcengine: VolcengineTtsProvider,
};
let ttsProvider;
let ttsProviderName;


async function onNarrateOneMessage() {
    audioElement.src = '/sounds/silence.mp3';
    const context = getContext();
    const id = $(this).closest('.mes').attr('mesid');
    const message = context.chat[id];

    if (!message) {
        return;
    }

    resetTtsPlayback();
    processAndQueueTtsMessage(message, Number(id), { manual: true });
    moduleWorker();
    if (extension_settings.tts.npcAttributionEnabled && extension_settings.tts.enabled) {
        parseAndCacheAttribution(context, Number(id)).catch((error) => {
            console.warn(`[tts] NPC attribution lazy parse failed for message ${id}`, error);
        });
    }
}

async function onNarrateText(args, text) {
    if (!text) {
        return '';
    }

    if (!extension_settings.tts.enabled) {
        toastr.warning(translate('TTS is disabled. Please enable it in the extension settings.'));
        return '';
    }

    audioElement.src = '/sounds/silence.mp3';

    // To load all characters in the voice map, set unrestricted to true
    await initVoiceMap(true);

    const baseName = args?.voice || name2;
    const name = (isSystemVoiceAlias(baseName) ? DEFAULT_VOICE_MARKER : baseName) || DEFAULT_VOICE_MARKER;

    const voiceMapEntry = voiceMap[name] === DEFAULT_VOICE_MARKER
        ? voiceMap[DEFAULT_VOICE_MARKER]
        : voiceMap[name];

    if (voiceMapEntry === DISABLED_VOICE_MARKER) {
        toastr.info(`TTS voice for ${name} is disabled.`);
        await initVoiceMap(false);
        return;
    }

    if (!voiceMapEntry) {
        toastr.info(`Specified voice for ${name} was not found. Check the TTS extension settings.`);
        await initVoiceMap(false);
        return;
    }

    resetTtsPlayback();
    processAndQueueTtsMessage({ mes: text, name: name }, null, { manual: true });
    await moduleWorker();

    // Return back to the chat voices
    await initVoiceMap(false);
    return '';
}

async function moduleWorker() {
    if (!extension_settings.tts.enabled) {
        return;
    }

    processTtsQueue();
    processAudioJobQueue();
    updateUiAudioPlayState();
}

function resetTtsPlayback() {
    // Stop system TTS utterance
    cancelTtsPlay();

    // Clear currently processing jobs
    currentTtsJob = null;
    currentAudioJob = null;

    // Reset audio element
    audioElement.currentTime = 0;
    audioElement.src = '';

    // Clear any queue items
    ttsJobQueue.splice(0, ttsJobQueue.length);
    audioJobQueue.splice(0, audioJobQueue.length);

    // Set audio ready to process again
    audioQueueProcessorReady = true;
}

function isTtsProcessing() {
    let processing = false;

    // Check job queues
    if (ttsJobQueue.length > 0 || audioJobQueue.length > 0) {
        processing = true;
    }
    // Check current jobs
    if (currentTtsJob != null || currentAudioJob != null) {
        processing = true;
    }
    return processing;
}

/**
 * @typedef {ChatMessage & { id?: number, manual?: boolean, segmentText?: string, segmentType?: string }} TtsMessage
 */

/**
 * Clones a message, attaches the given message ID, then splits by paragraphs
 * (if enabled) and adds each part to the TTS job queue.
 * @param {ChatMessage} message - The message object to be processed.
 * @param {number|null} [messageId=null] - The chat message index to associate with TTS events.
 * @param {object} [options={}] - Additional options for processing.
 * @param {boolean} [options.manual=false] - Whether this TTS job was manually triggered (e.g., from the UI) rather than automatically from a new chat message.
 * @returns {void}
 */
function processAndQueueTtsMessage(message, messageId = null, { manual = false } = {}) {
    /** @type {TtsMessage} */
    const clone = structuredClone(message);
    clone.id = messageId ?? null;
    clone.manual = manual ?? false;
    clone.originalMes = clone.mes;

    if (!extension_settings.tts.narrate_by_paragraphs) {
        ttsJobQueue.push(clone);
        return;
    }

    const lines = clone.mes.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.length === 0) {
            continue;
        }

        ttsJobQueue.push(
            Object.assign({}, clone, {
                mes: line,
            }),
        );
    }
}

function debugTtsPlayback() {
    console.log(JSON.stringify(
        {
            'ttsProviderName': ttsProviderName,
            'voiceMap': voiceMap,
            'audioPaused': audioPaused,
            'audioJobQueue': audioJobQueue,
            'currentAudioJob': currentAudioJob,
            'audioQueueProcessorReady': audioQueueProcessorReady,
            'ttsJobQueue': ttsJobQueue,
            'currentTtsJob': currentTtsJob,
            'ttsConfig': extension_settings.tts,
        },
    ));
}
globalThis.debugTtsPlayback = debugTtsPlayback;

//##################//
//   Audio Control  //
//##################//

let audioElement = new Audio();
audioElement.id = 'tts_audio';
audioElement.autoplay = true;

/**
 * @type AudioJob[] Audio job queue
 * @typedef {{audioBlob: Blob | string, char: string}} AudioJob Audio job object
 */
const audioJobQueue = [];
/**
 * @type AudioJob Current audio job
 */
let currentAudioJob;
let audioPaused = false;
let audioQueueProcessorReady = true;

/**
 * Play audio data from audio job object.
 * @param {AudioJob} audioJob Audio job object
 * @returns {Promise<void>} Promise that resolves when audio playback is started
 */
async function playAudioData(audioJob) {
    const { audioBlob, char } = audioJob;
    // Since current audio job can be cancelled, don't playback if it is null
    if (currentAudioJob == null) {
        console.log('Cancelled TTS playback because currentAudioJob was null');
    }
    if (audioBlob instanceof Blob) {
        const srcUrl = await getBase64Async(audioBlob);

        // VRM lip sync
        if (extension_settings.vrm?.enabled && typeof globalThis.vrmLipSync === 'function') {
            await globalThis.vrmLipSync(audioBlob, char);
        }

        audioElement.src = srcUrl;
    } else if (typeof audioBlob === 'string') {
        audioElement.src = audioBlob;
    } else {
        throw `TTS received invalid audio data type ${typeof audioBlob}`;
    }
    audioElement.addEventListener('ended', completeCurrentAudioJob);
    audioElement.addEventListener('canplay', () => {
        console.debug('Starting TTS playback');
        audioElement.playbackRate = extension_settings.tts.playback_rate;
        audioElement.play();
    });
}

globalThis.tts_preview = function (id) {
    const audio = document.getElementById(id);

    if (audio instanceof HTMLAudioElement && !$(audio).data('disabled')) {
        audio.play();
    } else {
        void ttsProvider.previewTtsVoice(id).catch(error => {
            toastr.error(error.toString(), 'TTS Preview Failed');
            console.error(error);
        });
    }
};

async function onTtsVoicesClick() {
    let popupText = '';

    try {
        const voiceIds = await ttsProvider.fetchTtsVoiceObjects();

        for (const voice of voiceIds) {
            popupText += `
            <div class="voice_preview">
                <span class="voice_lang">${voice.lang || ''}</span>
                <b class="voice_name">${voice.name}</b>
                <i onclick="tts_preview('${voice.voice_id}')" class="fa-solid fa-play"></i>
            </div>`;
            if (voice.preview_url) {
                popupText += `<audio id="${voice.voice_id}" src="${voice.preview_url}" data-disabled="${voice.preview_url == false}"></audio>`;
            }
        }
    } catch {
        popupText = 'Could not load voices list. Check your API key.';
    }

    callGenericPopup(popupText, POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true });
}

function updateUiAudioPlayState() {
    if (extension_settings.tts.enabled == true) {
        $('#ttsExtensionMenuItem').show();
        let img;
        // Give user feedback that TTS is active by setting the stop icon if processing or playing
        if (!audioElement.paused || isTtsProcessing()) {
            img = 'fa-solid fa-stop-circle extensionsMenuExtensionButton';
        } else {
            img = 'fa-solid fa-circle-play extensionsMenuExtensionButton';
        }
        $('#tts_media_control').attr('class', img);
    } else {
        $('#ttsExtensionMenuItem').hide();
    }
}

function onAudioControlClicked() {
    audioElement.src = '/sounds/silence.mp3';
    let context = getContext();
    // Not pausing, doing a full stop to anything TTS is doing. Better UX as pause is not as useful
    if (!audioElement.paused || isTtsProcessing()) {
        resetTtsPlayback();
    } else if (context?.chat?.length > 0) {
        // Default play behavior if not processing or playing is to play the last message.
        const id = context.chat.length - 1;
        processAndQueueTtsMessage(context.chat[id], id, { manual: true });
    }
    updateUiAudioPlayState();
}

function addAudioControl() {
    $('#tts_wand_container').append(applyLocale(`
        <div id="ttsExtensionMenuItem" class="list-group-item flex-container flexGap5">
            <div id="tts_media_control" class="extensionsMenuExtensionButton "/></div>
            <span data-i18n="TTS Playback">TTS Playback</span>
        </div>`));
    $('#tts_wand_container').append(applyLocale(`
        <div id="ttsExtensionNarrateAll" class="list-group-item flex-container flexGap5">
            <div class="extensionsMenuExtensionButton fa-solid fa-radio"></div>
            <span data-i18n="Narrate All Chat">Narrate All Chat</span>
        </div>`));
    $('#ttsExtensionMenuItem').attr('title', t`TTS play/pause`).attr('data-i18n', '[title]TTS play/pause').on('click', onAudioControlClicked);
    $('#ttsExtensionNarrateAll').attr('title', t`Narrate all messages in the current chat. Includes user messages, excludes hidden comments.`).attr('data-i18n', '[title]Narrate all messages in the current chat. Includes user messages, excludes hidden comments.').on('click', playFullConversation);
    updateUiAudioPlayState();
}

function completeCurrentAudioJob() {
    audioQueueProcessorReady = true;
    currentAudioJob = null;
    // updateUiPlayState();
    wrapper.update();
}

/**
 * Accepts an HTTP response containing audio/mpeg data, and puts the data as a Blob() on the queue for playback
 * @param {Response} response
 * @param {string} char
 * @returns {Promise<{audioBlob: Blob|string, mimeType: string}>}
 */
async function addAudioJob(response, char) {
    let audioBlob, mimeType;
    if (typeof response === 'string') {
        audioBlob = response;
        mimeType = '';
    } else {
        audioBlob = await response.blob();
        if (!audioBlob.type.startsWith('audio/')) {
            throw `TTS received HTTP response with invalid data format. Expecting audio/*, got ${audioBlob.type}`;
        }
        mimeType = audioBlob.type;
    }
    audioJobQueue.push({ audioBlob, char });
    console.debug('Pushed audio job to queue.');
    return { audioBlob, mimeType };
}

async function processAudioJobQueue() {
    // Nothing to do, audio not completed, or audio paused - stop processing.
    if (audioJobQueue.length == 0 || !audioQueueProcessorReady || audioPaused) {
        return;
    }
    try {
        audioQueueProcessorReady = false;
        currentAudioJob = audioJobQueue.shift();
        playAudioData(currentAudioJob);
    } catch (error) {
        toastr.error(error.toString());
        console.error(error);
        audioQueueProcessorReady = true;
    }
}

//################//
//  TTS Control   //
//################//

/** @type {TtsMessage[]} */
const ttsJobQueue = [];
/** @type {TtsMessage|null} */
let currentTtsJob = null; // Null if nothing is currently being processed

function completeTtsJob() {
    console.info(`Current TTS job for ${currentTtsJob?.name} completed.`);
    currentTtsJob = null;
}

async function tts(text, voiceId, char, voiceMapKey = null) {
    const messageId = currentTtsJob?.id ?? null;

    await eventSource.emit(event_types.TTS_JOB_STARTED, { messageId, characterName: char, text, voiceId });

    async function processResponse(response) {
        // RVC injection
        if (typeof globalThis.rvcVoiceConversion === 'function' && extension_settings.rvc.enabled)
            response = await globalThis.rvcVoiceConversion(response, char, text);

        const audioResult = await addAudioJob(response, char);
        const eventData = { messageId, characterName: char, text, audio: audioResult.audioBlob, mimeType: audioResult.mimeType };
        await eventSource.emit(event_types.TTS_AUDIO_READY, eventData);
    }

    // voiceMapKey can also include segment qualifiers, e.g. '{char} ("Quotes")'
    let response = await ttsProvider.generateTts(text, voiceId, voiceMapKey);

    // If async generator, process every chunk as it comes in
    if (typeof response[Symbol.asyncIterator] === 'function') {
        for await (const chunk of response) {
            await processResponse(chunk);
        }
    } else {
        await processResponse(response);
    }

    await eventSource.emit(event_types.TTS_JOB_COMPLETE, { messageId, characterName: char });
    completeTtsJob();
}

function parseMessageSegments(text) {
    if (!extension_settings.tts.multi_voice_enabled) {
        return [{ type: 'other', text: text }];
    }

    const segments = [];
    const segmentRegex = /(\*[^*]*?\*)|(".*?")|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim;
    let lastIndex = 0;
    let match;

    segmentRegex.lastIndex = 0;

    while ((match = segmentRegex.exec(text)) !== null) {
        // Add other text before this match
        if (match.index > lastIndex) {
            const otherText = text.substring(lastIndex, match.index).trim();
            if (otherText && otherText.length > 0) {
                segments.push({ type: 'other', text: otherText });
            }
        }

        const matchedText = match[0];
        let segmentType = 'other';
        let content = '';

        if (match[1]) {
            // Asterisk content (*action*)
            segmentType = 'action';
            content = matchedText.slice(1, -1);
        } else if (match[2] || match[3] || match[4] || match[5] || match[6] || match[7]) {
            // Various quote types ("dialogue")
            segmentType = 'dialogue';
            content = matchedText.slice(1, -1);
        }

        // Trim and check for actual content
        content = content.trim();
        if (content.length > 0) {
            segments.push({
                type: segmentType,
                text: content,
            });
        }

        lastIndex = match.index + matchedText.length;
    }

    // Add remaining other text after last match
    if (lastIndex < text.length) {
        const otherText = text.substring(lastIndex).trim();
        if (otherText.length > 0) {
            segments.push({ type: 'other', text: otherText });
        }
    }

    // If no segments found and not empty, treat whole text as other text
    if (segments.length === 0 && text.trim().length > 0) {
        segments.push({ type: 'other', text: text.trim() });
    }

    return segments;
}

async function processTtsQueue() {
    // Called each moduleWorker iteration to pull chat messages from queue
    if (currentTtsJob || ttsJobQueue.length <= 0 || audioPaused) {
        return;
    }

    console.debug('New message found, running TTS');
    currentTtsJob = ttsJobQueue.shift();

    // Handle segmented jobs that already have processed text
    if (currentTtsJob.segmentType && currentTtsJob.segmentText) {
        const char = currentTtsJob.name;
        const segmentText = currentTtsJob.segmentText;
        const segmentType = currentTtsJob.segmentType;

        console.log(`TTS (${segmentType}): ${segmentText}`);

        try {
            let voiceMapKey = char;
            let speakerName = null;

            // NPC attribution: consult the per-chat cache for this dialogue segment
            if (extension_settings.tts.npcAttributionEnabled
                && segmentType === 'dialogue'
                && Number.isInteger(currentTtsJob.qIndex)
                && Number.isInteger(currentTtsJob.id)) {
                const attributionMap = await loadAttributionMap(getContext());
                const entry = readAttributionFor(getContext(), attributionMap, currentTtsJob.id);
                const speaker = entry?.segments?.find(s => s.qIndex === currentTtsJob.qIndex)?.speaker;
                if (typeof speaker === 'string' && speaker.length > 0) {
                    speakerName = speaker;
                }
            }

            const voiceChar = speakerName ?? char;

            // If multi-voice is enabled, modify the voice map key based on segment type
            if (extension_settings.tts.multi_voice_enabled && voiceChar !== DEFAULT_VOICE_MARKER) {
                switch (segmentType) {
                    case 'dialogue':
                        voiceMapKey = `${voiceChar} ("Quotes")`;
                        break;
                    case 'action':
                        voiceMapKey = `${voiceChar} (*Text inside asterisks*)`;
                        break;
                    case 'other':
                    default:
                        voiceMapKey = `${voiceChar} (Other text)`;
                        break;
                }
            } else {
                voiceMapKey = voiceChar;
            }

            const voiceMapEntry = voiceMap[voiceMapKey] === DEFAULT_VOICE_MARKER ? voiceMap[DEFAULT_VOICE_MARKER] : voiceMap[voiceMapKey];
            if (voiceMapEntry === DISABLED_VOICE_MARKER) {
                const storageKey = `tts_disabled_warned_${voiceChar}`;
                if (!accountStorage.getItem(storageKey) || currentTtsJob.manual) {
                    accountStorage.setItem(storageKey, 'true');
                    toastr.info(`TTS voice for ${voiceChar} is disabled.`);
                }
                currentTtsJob = null;
                setTimeout(() => wrapper.update(), 0);
                return;
            }
            if (!voiceMapEntry) {
                throw `${voiceChar} not in voicemap. Configure character in extension settings voice map`;
            }
            const voice = await ttsProvider.getVoice(voiceMapEntry);
            const voiceId = voice.voice_id;
            if (voiceId == null) {
                toastr.error(`Specified voice for ${voiceChar} was not found. Check the TTS extension settings.`);
                throw `Unable to attain voiceId for ${voiceChar}`;
            }
            await tts(segmentText, voiceId, voiceChar, voiceMapKey);
        } catch (error) {
            toastr.error(error.toString());
            console.error(error);
            currentTtsJob = null;
        }
        return;
    }

    // Process unsegmented job (first time processing)
    let text = extension_settings.tts.narrate_translated_only ? (currentTtsJob?.extra?.display_text || currentTtsJob.mes) : currentTtsJob.mes;

    // Substitute macros
    text = substituteParams(text);

    if (extension_settings.tts.skip_codeblocks) {
        text = text.replace(/```.*?```/gs, '').trim();
        text = text.replace(/~~~.*?~~~/gs, '').trim();
    }

    if (extension_settings.tts.skip_tags) {
        text = text.replace(/<.*?>[\s\S]*?<\/.*?>/g, '').trim();
    }

    if (!extension_settings.tts.pass_asterisks) {
        text = extension_settings.tts.narrate_dialogues_only
            ? text.replace(/\*[^*]*?(\*|$)/g, '').trim() // remove asterisks content
            : text.replaceAll('*', '').trim(); // remove just the asterisks
    }

    if (extension_settings.tts.apply_regex && extension_settings.tts.regex_pattern) {
        const regex = regexFromString(extension_settings.tts.regex_pattern);
        if (regex) {
            // Clean up extra spaces that might be left after removal
            text = text.replace(regex, '').replace(/\s+/g, ' ').trim();
        } else {
            console.warn('Invalid regex pattern:', extension_settings.tts.regex_pattern);
        }
    }

    if (extension_settings.tts.narrate_quoted_only) {
        const partJoiner = (ttsProvider?.separator || ' ... ');
        text = joinQuotedBlocks(text, { separator: partJoiner, includeQuotes: true });
    }

    // Remove embedded images
    text = text.replace(/!\[.*?]\([^)]*\)/g, '');

    if (typeof ttsProvider?.processText === 'function') {
        text = await ttsProvider.processText(text);
    }

    // Collapse newlines and spaces into single space
    text = text.replace(/\s+/g, ' ').trim();

    console.log(`TTS: ${text}`);
    const char = currentTtsJob.name;

    // Remove character name from start of the line if power user setting is disabled
    if (char && !power_user.allow_name2_display) {
        const escapedChar = escapeRegex(char);
        text = text.replace(new RegExp(`^${escapedChar}:`, 'gm'), '');
    }

    try {
        if (!text) {
            console.warn('Got empty text in TTS queue job.');
            completeTtsJob();
            return;
        }

        // Parse message into segments if multi-voice is enabled
        const segments = parseMessageSegments(text);

        // Attach whole-message quote indices so the queue path can consult
        // the attribution cache; the quote window is computed from the
        // pre-filter message text (filters must not shift quote order).
        const attributionWindow = extractQuoteSegments(currentTtsJob.originalMes ?? currentTtsJob.mes);
        attachQuoteIndices(segments, attributionWindow);

        if (segments.length === 0) {
            console.warn('No valid segments found in text.');
            completeTtsJob();
            return;
        }

        // Add all segments to the queue as separate jobs (in reverse order so they process in correct order)
        for (let i = segments.length - 1; i >= 0; i--) {
            const segmentJob = {
                name: char,
                segmentType: segments[i].type,
                segmentText: segments[i].text,
                qIndex: segments[i].qIndex,
                is_user: currentTtsJob.is_user,
                mes: currentTtsJob.mes,
                originalMes: currentTtsJob.originalMes,
                extra: currentTtsJob.extra,
                id: currentTtsJob.id,
                manual: currentTtsJob.manual,
            };
            ttsJobQueue.unshift(segmentJob);
        }

        // Clear current job so the segmented jobs can be processed
        currentTtsJob = null;
    } catch (error) {
        toastr.error(error.toString());
        console.error(error);
        currentTtsJob = null;
    }
}

/**
 * Extract and join quoted blocks with proper matching pairs and nesting.
 * - Captures outermost quotes and everything inside (including different inner quote styles).
 * - Requires matching opener/closer style (e.g., “ ... ”, 「 ... 」, « ... », etc.).
 * - Ignores incomplete/unclosed quotes (doesn't include them in the result).
 * - Symmetric quotes like "..." and ＂...＂ are supported (not nesting the same symmetric style).
 *
 * @param {string} text - The text to process
 * @param {object} [opts={}] - Optional options object
 * @param {string} [opts.separator=' ... '] - String to join multiple quoted blocks
 * @param {boolean} [opts.includeQuotes=true] - Keep the quote chars around the captured text
 * @param {boolean} [opts.returnEmptyOnNoQuotes=false] - Return an empty string if no quotes are found
 * @param {Array<[string,string]>} [opts.pairs] - Custom quote pairs; defaults cover EN/DE/FR/JP
 * @returns {string} The joined quoted blocks, or the original text if no quotes found
 */
function joinQuotedBlocks(text, opts = {}) {
    const {
        separator = ' ... ',
        includeQuotes = true,
        returnEmptyOnNoQuotes = false,
        pairs = [
            // typographic doubles
            ['„', '“'],          // DE low-high
            ['“', '”'],          // EN
            ['«', '»'],          // FR open « close »
            ['»', '«'],          // Some locales open »
            // typographic singles
            ['‘', '’'],
            ['‚', '‘'],
            // Japanese corner quotes
            ['「', '」'],
            ['『', '』'],
            // symmetric doubles
            ['"', '"'],
            ['＂', '＂'],
        ],
    } = opts;

    if (!text || typeof text !== 'string') return text;

    const openToClose = Object.fromEntries(pairs);

    const segments = [];
    const stack = []; // [{ opener, expectedClose, start }]
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const top = stack[stack.length - 1];

        // Prefer closing the current open pair if the char matches its expected closer
        if (top && ch === top.expectedClose) {
            const finished = stack.pop();
            if (stack.length === 0) {
                // Only collect outermost quotes (contains all nested content)
                segments.push(text.slice(finished.start, i + 1));
            }
            continue;
        }

        // Otherwise, see if this is a new opener
        if (openToClose[ch]) {
            stack.push({ opener: ch, expectedClose: openToClose[ch], start: i });
            continue;
        }

        // If it's a stray closer that doesn't match current top, ignore
    }

    if (!segments.length) return returnEmptyOnNoQuotes ? '' : text;

    const cleaned = includeQuotes
        ? segments
        : segments.map(s => s.slice(1, -1)); // all defined pairs are single-char quotes

    return cleaned.join(separator);
}

async function playFullConversation() {
    resetTtsPlayback();

    if (!extension_settings.tts.enabled) {
        return toastr.warning(translate('TTS is disabled. Please enable it in the extension settings.'));
    }

    const context = getContext();

    context.chat.forEach((msg, i) => {
        if (!msg.is_system && msg.mes !== '...' && msg.mes !== '') {
            processAndQueueTtsMessage(msg, i, { manual: false });
        }
    });

    if (ttsJobQueue.length === 0) {
        return toastr.info('No messages to narrate.');
    }
}

globalThis.playFullConversation = playFullConversation;

//#############################//
//  Extension UI and Settings  //
//#############################//

function loadSettings() {
    if (Object.keys(extension_settings.tts).length === 0) {
        Object.assign(extension_settings.tts, defaultSettings);
    }
    for (const key in defaultSettings) {
        if (!(key in extension_settings.tts)) {
            extension_settings.tts[key] = defaultSettings[key];
        }
    }
    if (extension_settings.tts.currentProvider === 'Coqui') {
        extension_settings.tts.currentProvider = 'System';
    }
    $('#tts_provider').val(extension_settings.tts.currentProvider);
    $('#tts_enabled').prop(
        'checked',
        extension_settings.tts.enabled,
    );
    $('#tts_narrate_dialogues').prop('checked', extension_settings.tts.narrate_dialogues_only);
    $('#tts_narrate_quoted').prop('checked', extension_settings.tts.narrate_quoted_only);
    $('#tts_auto_generation').prop('checked', extension_settings.tts.auto_generation);
    $('#tts_periodic_auto_generation').prop('checked', extension_settings.tts.periodic_auto_generation);
    $('#tts_narrate_by_paragraphs').prop('checked', extension_settings.tts.narrate_by_paragraphs);
    $('#tts_narrate_translated_only').prop('checked', extension_settings.tts.narrate_translated_only);
    $('#tts_narrate_user').prop('checked', extension_settings.tts.narrate_user);
    $('#tts_pass_asterisks').prop('checked', extension_settings.tts.pass_asterisks);
    $('#tts_skip_codeblocks').prop('checked', extension_settings.tts.skip_codeblocks);
    $('#tts_skip_tags').prop('checked', extension_settings.tts.skip_tags);
    $('#tts_multi_voice_enabled').prop('checked', extension_settings.tts.multi_voice_enabled);
    $('#tts_apply_regex').prop('checked', extension_settings.tts.apply_regex);
    $('#tts_regex_pattern').val(extension_settings.tts.regex_pattern);
    $('#tts_regex_block').toggle(extension_settings.tts.apply_regex);
    updateRegexPatternWarning();
    $('#playback_rate').val(extension_settings.tts.playback_rate);
    $('#playback_rate_counter').val(Number(extension_settings.tts.playback_rate).toFixed(2));
    $('#playback_rate_block').toggle(extension_settings.tts.currentProvider !== 'System');

    $('#tts_npc_attribution_enabled').prop('checked', extension_settings.tts.npcAttributionEnabled);
    $('#tts_npc_attribution_retry_max').val(extension_settings.tts.npcAttributionRetryMax);
    renderTtsAttributionSelectors(getContext());

    $('body').toggleClass('tts', extension_settings.tts.enabled);
}

const defaultSettings = {
    voiceMap: '',
    ttsEnabled: false,
    currentProvider: 'ElevenLabs',
    auto_generation: true,
    narrate_user: false,
    playback_rate: 1,
    multi_voice_enabled: false,
    apply_regex: false,
    regex_pattern: '',
    npcAttributionEnabled: false,
    npcAttributionApiPresetName: '',
    npcAttributionPresetName: '',
    npcAttributionRetryMax: 2,
};

function setTtsStatus(status, success) {
    $('#tts_status').text(status);
    if (success) {
        $('#tts_status').removeAttr('style');
    } else {
        $('#tts_status').css('color', 'red');
    }
}

function onRefreshClick() {
    Promise.all([
        ttsProvider.onRefreshClick(),
        // updateVoiceMap()
    ]).then(() => {
        extension_settings.tts[ttsProviderName] = ttsProvider.settings;
        saveSettingsDebounced();
        setTtsStatus('Successfully applied settings', true);
        console.info(`Saved settings ${ttsProviderName} ${JSON.stringify(ttsProvider.settings)}`);
        initVoiceMap();
        updateVoiceMap();
    }).catch(error => {
        toastr.error(error.toString());
        console.error(error);
        setTtsStatus(error, false);
    });
}

function onEnableClick() {
    extension_settings.tts.enabled = $('#tts_enabled').is(
        ':checked',
    );
    updateUiAudioPlayState();
    saveSettingsDebounced();
    $('body').toggleClass('tts', extension_settings.tts.enabled);
}


function onAutoGenerationClick() {
    extension_settings.tts.auto_generation = !!$('#tts_auto_generation').prop('checked');
    saveSettingsDebounced();
}


function onPeriodicAutoGenerationClick() {
    extension_settings.tts.periodic_auto_generation = !!$('#tts_periodic_auto_generation').prop('checked');
    saveSettingsDebounced();
}

function onNarrateByParagraphsClick() {
    extension_settings.tts.narrate_by_paragraphs = !!$('#tts_narrate_by_paragraphs').prop('checked');
    saveSettingsDebounced();
}


function onNarrateDialoguesClick() {
    extension_settings.tts.narrate_dialogues_only = !!$('#tts_narrate_dialogues').prop('checked');
    saveSettingsDebounced();
}

function onNarrateUserClick() {
    extension_settings.tts.narrate_user = !!$('#tts_narrate_user').prop('checked');
    saveSettingsDebounced();
}

function onNarrateQuotedClick() {
    extension_settings.tts.narrate_quoted_only = !!$('#tts_narrate_quoted').prop('checked');
    saveSettingsDebounced();
}


function onNarrateTranslatedOnlyClick() {
    extension_settings.tts.narrate_translated_only = !!$('#tts_narrate_translated_only').prop('checked');
    saveSettingsDebounced();
}

function onSkipCodeblocksClick() {
    extension_settings.tts.skip_codeblocks = !!$('#tts_skip_codeblocks').prop('checked');
    saveSettingsDebounced();
}

function onSkipTagsClick() {
    extension_settings.tts.skip_tags = !!$('#tts_skip_tags').prop('checked');
    saveSettingsDebounced();
}

function onPassAsterisksClick() {
    extension_settings.tts.pass_asterisks = !!$('#tts_pass_asterisks').prop('checked');
    saveSettingsDebounced();
    console.log('setting pass asterisks', extension_settings.tts.pass_asterisks);
}

function onMultiVoiceClick() {
    extension_settings.tts.multi_voice_enabled = !!$('#tts_multi_voice_enabled').prop('checked');
    saveSettingsDebounced();
    // Reinitialize voice map to show/hide voices
    initVoiceMap();
}

function onApplyRegexChange() {
    extension_settings.tts.apply_regex = !!$('#tts_apply_regex').prop('checked');
    saveSettingsDebounced();
    $('#tts_regex_block').toggle(extension_settings.tts.apply_regex);
    updateRegexPatternWarning();
}

function onRegexPatternChange() {
    extension_settings.tts.regex_pattern = $('#tts_regex_pattern').val().toString();
    saveSettingsDebounced();
    updateRegexPatternWarning();
}

function onNpcAttributionEnabledClick() {
    extension_settings.tts.npcAttributionEnabled = !!$('#tts_npc_attribution_enabled').prop('checked');
    saveSettingsDebounced();
}

function onNpcAttributionApiPresetChange() {
    extension_settings.tts.npcAttributionApiPresetName = String($('#tts_npc_attribution_api_preset').val() || '').trim();
    saveSettingsDebounced();
}

function onNpcAttributionPresetChange() {
    extension_settings.tts.npcAttributionPresetName = String($('#tts_npc_attribution_preset').val() || '').trim();
    saveSettingsDebounced();
}

function onNpcAttributionRetryMaxChange() {
    const clamped = Math.max(0, Math.floor(Number($('#tts_npc_attribution_retry_max').val()) || 0));
    extension_settings.tts.npcAttributionRetryMax = clamped;
    $('#tts_npc_attribution_retry_max').val(clamped);
    saveSettingsDebounced();
}

/**
 * Build the voice-map management popup content: one select row per
 * mapped/participant name, an inline add entry, and a per-row remove
 * button for voice-map-owned names (not chat participants).
 * @param {VoiceMapEntry[]} entries current voiceMapEntries
 * @returns {JQuery<HTMLElement>} detached popup content
 */
function buildVoiceMapPopupContent(entries, voiceIds) {
    const content = $('<div id="tts_voicemap_popup">');
    const addRow = $('<div class="tts_voicemap_add">');
    const nameInput = $('<input id="tts_voicemap_add_name" class="text_pole" type="text">')
        .attr('placeholder', translate('Add a speaker name…'));
    const addButton = $('<input id="tts_voicemap_add" class="menu_button" type="button">')
        .attr('value', translate('Add'));
    addRow.append(nameInput, addButton);
    content.append(addRow);

    const rows = $('<div id="tts_voicemap_block">');
    for (const entry of entries) {
        const row = entry.renderRow(voiceIds);
        if (isNpcVoiceMapKey(entry.name)) {
            const removeButton = $('<i class="tts_voicemap_remove fa-solid fa-xmark" role="button"></i>')
                .attr('title', translate('Remove from voice map'));
            row.append(removeButton);
        }
        rows.append(row);
    }
    content.append(rows);
    return content;
}

/**
 * Wire add + change + remove behaviour for the voice-map popup. Changes
 * apply to the live entries; persistence happens through syncVoiceMapFromEntries
 * on close, removal rewrites the provider voiceMap directly.
 */
function wireVoiceMapPopup(content) {
    content.find('.tts_voicemap_block_char select').on('change', () => syncVoiceMapFromEntries());

    // Add/remove rebuild the popup with fresh rows: close the current
    // voice-map popup instance (its complete() runs the close animation
    // and resolves the awaiting openVoiceMapPopup), then reopen.
    const reopenPopup = async () => {
        const current = Popup.util.popups.find(p => p.content?.querySelector?.('#tts_voicemap_popup'));
        if (current) {
            await current.completeCancelled();
        }
        await openVoiceMapPopup(true);
    };

    const onAdd = async () => {
        const name = String(content.find('#tts_voicemap_add_name').val() || '').trim();
        if (!name) {
            toastr.info(translate('Enter a name to add to the voice map.'));
            return;
        }
        const providerName = extension_settings.tts.currentProvider;
        const providerSettings = extension_settings.tts[providerName];
        if (!providerSettings) {
            return;
        }
        const added = await ensureNpcVoiceMapEntries(providerName, [name]);
        if (added.length === 0) {
            toastr.info(translate('That name is already in the voice map.'));
            return;
        }
        content.find('#tts_voicemap_add_name').val('');
        await reopenPopup();
    };
    content.find('#tts_voicemap_add').on('click', onAdd);
    content.find('#tts_voicemap_add_name').on('keydown', async (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            await onAdd();
        }
    });

    content.find('.tts_voicemap_remove').on('click', async function () {
        const rowLabel = $(this).siblings('span').first().text();
        // Multi-voice rows are labelled with the segment suffix
        // ("Quotes" / asterisks / "Other text") while the map keys are
        // matched on the bare name; strip before comparing.
        const nameSpan = rowLabel.includes(' (') ? rowLabel.slice(0, rowLabel.lastIndexOf(' (')) : rowLabel;
        const providerName = extension_settings.tts.currentProvider;
        const providerSettings = extension_settings.tts[providerName];
        if (!providerSettings || !providerSettings.voiceMap || typeof providerSettings.voiceMap !== 'object') {
            return;
        }
        for (const key of Object.keys(providerSettings.voiceMap)) {
            const bareName = key.includes(' (') ? key.slice(0, key.lastIndexOf(' (')) : key;
            if (bareName === nameSpan) {
                delete providerSettings.voiceMap[key];
            }
        }
        // Entries are the popup's source of truth: dropping the key only
        // from provider settings would be undone at close, when
        // syncVoiceMapFromEntries writes every live entry back. Match on
        // the bare name so multi-voice segment rows go too — same
        // stripping the delete loop above uses.
        voiceMapEntries = voiceMapEntries.filter(entry => {
            const bareName = entry.name.includes(' (') ? entry.name.slice(0, entry.name.lastIndexOf(' (')) : entry.name;
            return bareName !== nameSpan;
        });
        saveSettingsDebounced();
        await reopenPopup();
    });
}

/**
 * Sync the module-level voiceMap + persisted provider voiceMap from the
 * popup's live entries (select changes during the popup session).
 */
function syncVoiceMapFromEntries() {
    const tempVoiceMap = {};
    for (const voice of voiceMapEntries) {
        if (voice.voiceId === null || voice.voiceId === undefined) {
            continue;
        }
        tempVoiceMap[voice.name] = voice.voiceId;
    }
    voiceMap = tempVoiceMap;
    if (!extension_settings.tts[ttsProviderName].voiceMap || typeof extension_settings.tts[ttsProviderName].voiceMap !== 'object') {
        extension_settings.tts[ttsProviderName].voiceMap = {};
    }
    // The popup lists exactly what the runtime map uses, so assign wholesale.
    Object.assign(extension_settings.tts[ttsProviderName].voiceMap, voiceMap);
    saveSettingsDebounced();
}

/**
 * Open the voice-map management popup. All rows (participants +
 * voiceMap-configured names) render here instead of inline in the
 * settings panel, keeping the panel light no matter how many names
 * accumulate.
 * @param {boolean} reopen skip initVoiceMap (already fresh in this session)
 */
async function openVoiceMapPopup(reopen = false) {
    if (!reopen) {
        await initVoiceMap();
    }
    const provider = ttsProvider;
    let voiceIds = [];
    try {
        voiceIds = await provider.fetchTtsVoiceObjects();
    } catch {
        toastr.error('TTS Provider failed to return voice ids.');
    }
    const content = buildVoiceMapPopupContent(voiceMapEntries, voiceIds);
    wireVoiceMapPopup(content);
    await callGenericPopup(content, POPUP_TYPE.TEXT, '', {
        okButton: translate('Done'),
        allowVerticalScrolling: true,
        wide: true,
        animation: 'none',
        onClosing: () => {
            syncVoiceMapFromEntries();
            return true;
        },
    });
    // Drop stale select references after the popup DOM is gone.
    voiceMapEntries.forEach(entry => { entry.selectElement = null; });
}

async function onVoicemapManageClick() {
    await openVoiceMapPopup();
}

function updateRegexPatternWarning() {
    const warning = $('#tts_regex_warning');
    if (!extension_settings.tts.apply_regex) {
        warning.hide();
        return;
    }

    const pattern = extension_settings.tts.regex_pattern;
    if (!pattern) {
        warning.hide();
        return;
    }

    const regex = regexFromString(pattern);
    warning.toggle(!regex);
}

//##############//
// TTS Provider //
//##############//

async function loadTtsProvider(provider) {
    //Clear the current config and add new config
    $('#tts_provider_settings').html('');

    if (!provider) {
        return;
    }

    // Init provider references
    extension_settings.tts.currentProvider = provider;
    ttsProviderName = provider;
    ttsProvider = new ttsProviders[provider];

    // Init provider settings
    $('#tts_provider_settings').append(ttsProvider.settingsHtml);
    if (!(ttsProviderName in extension_settings.tts)) {
        console.warn(`Provider ${ttsProviderName} not in Extension Settings, initiatilizing provider in settings`);
        extension_settings.tts[ttsProviderName] = {};
    }
    await ttsProvider.loadSettings(extension_settings.tts[ttsProviderName]);
    await initVoiceMap();
}

function onTtsProviderChange() {
    if (typeof ttsProvider?.dispose === 'function') {
        ttsProvider.dispose();
    }
    const ttsProviderSelection = $('#tts_provider').val();
    extension_settings.tts.currentProvider = ttsProviderSelection;
    $('#playback_rate_block').toggle(extension_settings.tts.currentProvider !== 'System');
    loadTtsProvider(ttsProviderSelection);
}

// Ensure that TTS provider settings are saved to extension settings.
export function saveTtsProviderSettings() {
    extension_settings.tts[ttsProviderName] = ttsProvider.settings;
    updateVoiceMap();
    saveSettingsDebounced();
    console.info(`Saved settings ${ttsProviderName} ${JSON.stringify(ttsProvider.settings)}`);
}


//###################//
// voiceMap Handling //
//###################//

async function onChatChanged() {
    await onGenerationEnded();
    resetTtsPlayback();
    const voiceMapInit = initVoiceMap();
    await Promise.race([voiceMapInit, delay(debounce_timeout.relaxed)]);
    lastMessage = null;
    if (extension_settings.tts.npcAttributionEnabled) {
        for (let i = 0; i < getContext().chat.length; i++) {
            decorateMessageWithPlayButtons(i);
        }
    }
}

async function onMessageEvent(messageId, lastCharIndex) {
    // If TTS is disabled, do nothing
    if (!extension_settings.tts.enabled) {
        return;
    }

    // Auto generation is disabled
    if (!extension_settings.tts.auto_generation) {
        return;
    }

    const context = getContext();

    // no characters or group selected
    if (!context.groupId && context.characterId === undefined) {
        return;
    }

    // Chat changed
    if (context.chatId !== lastChatId) {
        lastChatId = context.chatId;
        lastMessageHash = getStringHash(context.chat[messageId]?.mes ?? '');

        // Force to speak on the first message in the new chat
        if (context.chat.length === 1) {
            lastMessageHash = -1;
        }
    }

    // clone message object, as things go haywire if message object is altered below (it's passed by reference)
    /** @type {TtsMessage} */
    const message = structuredClone(context.chat[messageId]);
    const hashNew = getStringHash(message?.mes ?? '');

    // Ignore prompt-hidden messages
    if (message.is_system) {
        return;
    }

    // if no new messages, or same message, or same message hash, do nothing
    if (hashNew === lastMessageHash) {
        return;
    }

    // if we only want to process part of the message
    if (lastCharIndex) {
        message.mes = message.mes.substring(0, lastCharIndex);
    }

    const isLastMessageInCurrent = () =>
        lastMessage &&
        typeof lastMessage === 'object' &&
        message.swipe_id === lastMessage.swipe_id &&
        message.name === lastMessage.name &&
        message.is_user === lastMessage.is_user &&
        message.mes.indexOf(lastMessage.mes) !== -1;

    // if last message within current message, message got extended. only send diff to TTS.
    if (isLastMessageInCurrent()) {
        const tmp = structuredClone(message);
        message.mes = message.mes.replace(lastMessage.mes, '');
        lastMessage = tmp;
    } else {
        lastMessage = structuredClone(message);
    }

    // We're currently swiping. Don't generate voice
    if (!message || message.mes === '...' || message.mes === '') {
        return;
    }

    // Don't generate if message doesn't have a display text
    if (extension_settings.tts.narrate_translated_only && !(message?.extra?.display_text)) {
        return;
    }

    // Don't generate if message is a user message and user message narration is disabled
    if (message.is_user && !extension_settings.tts.narrate_user) {
        return;
    }

    // New messages, add new chat to history
    lastMessageHash = hashNew;
    lastChatId = context.chatId;

    console.debug(`Adding message from ${message.name} for TTS processing: "${message.mes}"`);

    if (extension_settings.tts.periodic_auto_generation && isStreamingEnabled()) {
        message.id = messageId;
        ttsJobQueue.push(message);
    } else {
        processAndQueueTtsMessage(message, messageId, { manual: false });
    }
}

async function onMessageDeleted() {
    const context = getContext();

    // update internal references to new last message
    lastChatId = context.chatId;

    // compare against lastMessageHash. If it's the same, we did not delete the last chat item, so no need to reset tts queue
    const messageHash = getStringHash((context.chat.length && context.chat[context.chat.length - 1].mes) ?? '');
    if (messageHash === lastMessageHash) {
        return;
    }
    lastMessageHash = messageHash;
    lastMessage = context.chat.length ? structuredClone(context.chat[context.chat.length - 1]) : null;

    // stop any tts playback since message might not exist anymore
    resetTtsPlayback();
}

async function onGenerationStarted(generationType, _args, isDryRun) {
    // If dry running or quiet mode, do nothing
    if (isDryRun || ['quiet', 'impersonate'].includes(generationType)) {
        return;
    }

    // If TTS is disabled, do nothing
    if (!extension_settings.tts.enabled) {
        return;
    }

    // Auto generation is disabled
    if (!extension_settings.tts.auto_generation) {
        return;
    }

    // Periodic auto generation is disabled
    if (!extension_settings.tts.periodic_auto_generation) {
        return;
    }

    // If the reply is not being streamed
    if (!isStreamingEnabled()) {
        return;
    }

    // start the timer
    if (!periodicMessageGenerationTimer) {
        periodicMessageGenerationTimer = setInterval(onPeriodicMessageGenerationTick, UPDATE_INTERVAL);
    }
}

async function onGenerationEnded() {
    if (periodicMessageGenerationTimer) {
        clearInterval(periodicMessageGenerationTimer);
        periodicMessageGenerationTimer = null;
    }
    lastPositionOfParagraphEnd = -1;
}

async function onPeriodicMessageGenerationTick() {
    const context = getContext();

    // no characters or group selected
    if (!context.groupId && context.characterId === undefined) {
        return;
    }

    const lastMessageId = context.chat.length - 1;

    // the last message was from the user
    if (context.chat[lastMessageId].is_user) {
        return;
    }

    const lastMessage = structuredClone(context.chat[lastMessageId]);
    const lastMessageText = lastMessage?.mes ?? '';

    // look for double ending lines which should indicate the end of a paragraph
    let newLastPositionOfParagraphEnd = lastMessageText
        .indexOf('\n\n', lastPositionOfParagraphEnd + 1);
    // if not found, look for a single ending line which should indicate the end of a paragraph
    if (newLastPositionOfParagraphEnd === -1) {
        newLastPositionOfParagraphEnd = lastMessageText
            .indexOf('\n', lastPositionOfParagraphEnd + 1);
    }

    // send the message to the tts module if we found the new end of a paragraph
    if (newLastPositionOfParagraphEnd > -1) {
        onMessageEvent(lastMessageId, newLastPositionOfParagraphEnd);

        if (periodicMessageGenerationTimer) {
            lastPositionOfParagraphEnd = newLastPositionOfParagraphEnd;
        }
    }
}

/**
 * Get characters in current chat
 * @param {boolean} unrestricted - If true, will include all characters in voiceMapEntries, even if they are not in the current chat.
 * @returns {string[]} - Array of character names
 */
export function getCharacters(unrestricted) {
    const context = getContext();

    if (unrestricted) {
        const names = context.characters.map(char => char.name);
        names.unshift(DEFAULT_VOICE_MARKER);
        return names.filter(onlyUnique);
    }

    let characters = [];
    if (context.groupId === null) {
        // Single char chat
        characters.push(DEFAULT_VOICE_MARKER);
        characters.push(context.name1);
        characters.push(context.name2);
    } else {
        // Group chat
        characters.push(DEFAULT_VOICE_MARKER);
        characters.push(context.name1);
        const group = context.groups.find(group => context.groupId == group.id);
        for (let member of group.members) {
            const character = context.characters.find(char => char.avatar == member);
            if (character) {
                characters.push(character.name);
            }
        }
    }
    characters = characters.filter(onlyUnique);

    // Merge NPC names discovered by attribution (they live in the
    // provider voiceMap but are not chat participants) so the settings
    // panel renders a select row for each; the multi-voice expansion
    // below then generates their segment keys naturally.
    const providerVoiceMap = extension_settings.tts[ttsProviderName]?.voiceMap;
    if (providerVoiceMap && typeof providerVoiceMap === 'object' && !Array.isArray(providerVoiceMap)) {
        for (const key of Object.keys(providerVoiceMap)) {
            const bareName = key.includes(' (') ? key.slice(0, key.lastIndexOf(' (')) : key;
            if (bareName && bareName !== DEFAULT_VOICE_MARKER && !characters.includes(bareName)) {
                characters.push(bareName);
            }
        }
        characters = characters.filter(onlyUnique);
    }

    // If multi-voice is enabled, expand characters to include segment types
    if (extension_settings.tts.multi_voice_enabled) {
        const expandedCharacters = [];
        for (const char of characters) {
            if (char === DEFAULT_VOICE_MARKER || isSystemVoiceAlias(char)) {
                expandedCharacters.push(char);
            } else {
                expandedCharacters.push(`${char} ("Quotes")`);
                expandedCharacters.push(`${char} (*Text inside asterisks*)`);
                expandedCharacters.push(`${char} (Other text)`);
            }
        }
        return expandedCharacters;
    }

    return characters;
}

/**
 * Whether a voice-map key names a speaker that is not a chat participant
 * (i.e. an NPC added manually or discovered by the attribution pass).
 * Multi-voice segment suffixes ("Quotes" / asterisks / "Other text") are
 * stripped before matching.
 * @param {string} key voiceMap key, possibly with a multi-voice suffix
 * @returns {boolean}
 */
export function isNpcVoiceMapKey(key) {
    if (typeof key !== 'string' || key.length === 0 || key === DEFAULT_VOICE_MARKER) {
        return false;
    }
    const bareName = key.includes(' (') ? key.slice(0, key.lastIndexOf(' (')) : key;
    if (bareName === DEFAULT_VOICE_MARKER || isSystemVoiceAlias(bareName)) {
        return false;
    }
    const context = getContext();
    const participants = [];
    participants.push(context.name1);
    if (context.groupId === null) {
        participants.push(context.name2);
    } else {
        const group = context.groups?.find(group => context.groupId == group.id);
        for (const member of group?.members ?? []) {
            const character = (context.characters ?? []).find(char => char.avatar == member);
            if (character) {
                participants.push(character.name);
            }
        }
    }
    return !participants.includes(bareName);
}

export function sanitizeId(input) {
    // Remove any non-alphanumeric characters except underscore (_) and hyphen (-)
    let sanitized = encodeURIComponent(input).replace(/[^a-zA-Z0-9-_]/g, '');

    // Ensure first character is always a letter
    if (!/^[a-zA-Z]/.test(sanitized)) {
        sanitized = 'element_' + sanitized;
    }

    return sanitized;
}

function parseVoiceMap(voiceMapString) {
    let parsedVoiceMap = {};
    for (const [charName, voiceId] of voiceMapString
        .split(',')
        .map(s => s.split(':'))) {
        if (charName && voiceId) {
            parsedVoiceMap[charName.trim()] = voiceId.trim();
        }
    }
    return parsedVoiceMap;
}


/**
 * Rebuild the runtime voiceMap from current voiceMapEntries and persist
 * it into the provider settings.
 */
function updateVoiceMap() {
    const tempVoiceMap = {};
    for (const voice of voiceMapEntries) {
        if (voice.voiceId === null) {
            continue;
        }
        tempVoiceMap[voice.name] = voice.voiceId;
    }
    if (Object.keys(tempVoiceMap).length !== 0) {
        voiceMap = tempVoiceMap;
        console.log(`Voicemap updated to ${JSON.stringify(voiceMap)}`);
    }
    if (!extension_settings.tts[ttsProviderName].voiceMap) {
        extension_settings.tts[ttsProviderName].voiceMap = {};
    }
    Object.assign(extension_settings.tts[ttsProviderName].voiceMap, voiceMap);
    saveSettingsDebounced();
}

class VoiceMapEntry {
    name;
    voiceId;
    selectElement;
    constructor(name, voiceId = DEFAULT_VOICE_MARKER) {
        this.name = name;
        this.voiceId = voiceId;
        this.selectElement = null;
    }

    renderRow(voiceIds) {
        const sanitizedName = sanitizeId(this.name);
        let defaultOption = this.name === DEFAULT_VOICE_MARKER ?
            `<option>${DISABLED_VOICE_MARKER}</option>` :
            `<option>${DEFAULT_VOICE_MARKER}</option><option>${DISABLED_VOICE_MARKER}</option>`;
        const npcTag = isNpcVoiceMapKey(this.name)
            ? `<span class='tts_voicemap_npc_tag' title="${translate('NPC voice')}">${translate('NPC')}</span>`
            : '';
        const template = `
            <div class='tts_voicemap_block_char'>
                <span class='tts_voicemap_char_name' id='tts_voicemap_char_${sanitizedName}'>${this.name}</span>
                ${npcTag}
                <select id='tts_voicemap_char_${sanitizedName}_voice'>
                    ${defaultOption}
                </select>
            </div>
        `;
        const row = $(template);

        // Populate voice ID select list
        for (const voiceId of voiceIds) {
            const option = document.createElement('option');
            option.innerText = voiceId.name;
            option.value = voiceId.name;
            row.find('select').append(option);
        }

        this.selectElement = row.find('select');
        this.selectElement.on('change', () => this.onSelectChange());
        this.selectElement.val(this.voiceId);
        return row;
    }

    onSelectChange() {
        this.voiceId = this.selectElement.find(':selected').val();
    }
}

/**
 * Init voiceMapEntries for character select list.
 * If an initialization is already in progress, it returns the existing Promise instead of starting a new one.
 * @param {boolean} unrestricted - If true, will include all characters in voiceMapEntries, even if they are not in the current chat.
 * @returns {Promise} A promise that resolves when the initialization is complete.
 */
export async function initVoiceMap(unrestricted = false) {
    // Preventing parallel execution
    if (currentInitVoiceMapPromise) {
        return currentInitVoiceMapPromise;
    }

    currentInitVoiceMapPromise = (async () => {
        const initialChatId = getCurrentChatId();
        try {
            await initVoiceMapInternal(unrestricted);
        } finally {
            currentInitVoiceMapPromise = null;
        }
        const currentChatId = getCurrentChatId();

        if (initialChatId !== currentChatId) {
            // Chat changed during initialization, reinitialize
            await initVoiceMap(unrestricted);
        }
    })();

    return currentInitVoiceMapPromise;
}

/**
 * Init voiceMapEntries for character select list.
 * @param {boolean} unrestricted - If true, will include all characters in voiceMapEntries, even if they are not in the current chat.
 */
async function initVoiceMapInternal(unrestricted) {
    // Voice-map entries are user configuration, not playback state: the
    // Manage voices popup renders them on demand, so they must be built
    // even while TTS is off or the provider is unreachable. Readiness
    // only drives the status indicator; it used to gate this build when
    // the panel rendered voice selects inline, but those now live in the
    // popup (see openVoiceMapPopup).
    const enabled = $('#tts_enabled').is(':checked');
    if (enabled) {
        // Keep errors inside extension UI rather than toastr. Toastr errors for TTS are annoying.
        try {
            await ttsProvider.checkReady();
            setTtsStatus('TTS Provider Loaded', true);
        } catch (error) {
            const message = `TTS Provider not ready. ${error}`;
            setTtsStatus(message, false);
        }
    }

    // Clear existing voiceMap state
    voiceMapEntries = [];

    // Get characters in current chat
    const characters = getCharacters(unrestricted);

    // Get saved voicemap from provider settings, handling new and old representations
    let voiceMapFromSettings = {};
    if ('voiceMap' in extension_settings.tts[ttsProviderName]) {
        // Handle previous representation
        if (typeof extension_settings.tts[ttsProviderName].voiceMap === 'string') {
            voiceMapFromSettings = parseVoiceMap(extension_settings.tts[ttsProviderName].voiceMap);
            // Handle new representation
        } else if (typeof extension_settings.tts[ttsProviderName].voiceMap === 'object') {
            voiceMapFromSettings = extension_settings.tts[ttsProviderName].voiceMap;
        }
    }

    // Build entries from chat participants + voiceMap keys. Rows are not
    // rendered inline — the Manage voices popup renders them on demand,
    // so the settings panel stays light no matter how many names exist.
    for (const character of characters) {
        if (isSystemVoiceAlias(character)) {
            continue;
        }
        // Check provider settings for voiceIds
        let voiceId;
        if (character in voiceMapFromSettings) {
            voiceId = voiceMapFromSettings[character];
        } else if (character === DEFAULT_VOICE_MARKER) {
            voiceId = DISABLED_VOICE_MARKER;
        } else {
            voiceId = DEFAULT_VOICE_MARKER;
        }
        const voiceMapEntry = new VoiceMapEntry(character, voiceId);
        voiceMapEntries.push(voiceMapEntry);
    }
    updateVoiceMap();
}

export function getRuntimeVoiceMap() {
    return voiceMap;
}

export function enqueueSegmentPlayback(name, segmentText, message, messageId) {
    resetTtsPlayback();
    ttsJobQueue.push({
        name,
        segmentType: 'dialogue',
        segmentText,
        is_user: message.is_user,
        mes: message.mes,
        extra: message.extra,
        id: messageId,
        manual: true,
    });
    wrapper.update();
}

export async function init() {
    async function addExtensionControls() {
        const settingsHtml = $(await renderExtensionTemplateAsync('tts', 'settings'));
        $('#tts_container').append(settingsHtml);
        $('#tts_refresh').on('click', onRefreshClick);
        $('#tts_enabled').on('click', onEnableClick);
        $('#tts_narrate_dialogues').on('click', onNarrateDialoguesClick);
        $('#tts_narrate_quoted').on('click', onNarrateQuotedClick);
        $('#tts_narrate_translated_only').on('click', onNarrateTranslatedOnlyClick);
        $('#tts_skip_codeblocks').on('click', onSkipCodeblocksClick);
        $('#tts_skip_tags').on('click', onSkipTagsClick);
        $('#tts_pass_asterisks').on('click', onPassAsterisksClick);
        $('#tts_auto_generation').on('click', onAutoGenerationClick);
        $('#tts_periodic_auto_generation').on('click', onPeriodicAutoGenerationClick);
        $('#tts_narrate_by_paragraphs').on('click', onNarrateByParagraphsClick);
        $('#tts_narrate_user').on('click', onNarrateUserClick);
        $('#tts_multi_voice_enabled').on('click', onMultiVoiceClick);
        $('#tts_apply_regex').on('change', onApplyRegexChange);
        $('#tts_regex_pattern').on('input', onRegexPatternChange);
        $('#tts_npc_attribution_enabled').on('click', onNpcAttributionEnabledClick);
        $('#tts_npc_attribution_api_preset').on('change', onNpcAttributionApiPresetChange);
        $('#tts_npc_attribution_preset').on('change', onNpcAttributionPresetChange);
        $('#tts_npc_attribution_retry_max').on('input', onNpcAttributionRetryMaxChange);
        $('#tts_voicemap_manage').on('click', onVoicemapManageClick);

        $('#playback_rate').on('input', function () {
            const value = $(this).val();
            const formattedValue = Number(value).toFixed(2);
            extension_settings.tts.playback_rate = value;
            $('#playback_rate_counter').val(formattedValue);
            saveSettingsDebounced();
        });

        $('#tts_voices').on('click', onTtsVoicesClick);
        for (const provider in ttsProviders) {
            $('#tts_provider').append($('<option />').val(provider).text(provider));
        }
        $('#tts_provider').on('change', onTtsProviderChange);
        $(document).on('click', '.mes_narrate', onNarrateOneMessage);
    }
    await addExtensionControls(); // No init dependencies
    loadSettings(); // Depends on Extension Controls and loadTtsProvider
    loadTtsProvider(extension_settings.tts.currentProvider); // No dependencies
    addAudioControl(); // Depends on Extension Controls
    setInterval(wrapper.update.bind(wrapper), UPDATE_INTERVAL); // Init depends on all the things
    eventSource.on(event_types.MESSAGE_SWIPED, resetTtsPlayback);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.on(event_types.GROUP_UPDATED, onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => onMessageEvent(messageId));
    eventSource.makeLast(event_types.USER_MESSAGE_RENDERED, (messageId) => onMessageEvent(messageId));
    // NPC attribution: parse after the existing narration handler (makeLast
    // chain appends after the one registered above for onMessageEvent).
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
        if (!extension_settings.tts.npcAttributionEnabled || !extension_settings.tts.enabled) return;
        parseAndCacheAttribution(getContext(), messageId).catch((error) => {
            console.warn(`[tts] NPC attribution parse failed for message ${messageId}`, error);
        });
    });
    // NPC attribution: decorate rendered character messages with per-quote
    // play buttons (after the parse-triggering makeLast handler above).
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
        if (!extension_settings.tts.npcAttributionEnabled) return;
        decorateMessageWithPlayButtons(messageId);
    });
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'speak',
        callback: async (args, value) => {
            await onNarrateText(args, value);
            return '';
        },
        aliases: ['narrate', 'tts'],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'voice',
                description: 'character voice name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumProvider: () => Object.keys(voiceMap).map(voiceName => new SlashCommandEnumValue(voiceName, null, enumTypes.enum, enumIcons.voice)),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
            <div>
                Narrate any text using currently selected character's voice.
            </div>
            <div>
                Use <code>voice="Character Name"</code> argument to set other voice from the voice map.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/speak voice="Donald Duck" Quack!</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));

    document.body.appendChild(audioElement);
}
